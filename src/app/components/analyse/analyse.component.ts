import { Component, signal, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser, CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MarkdownModule } from 'ngx-markdown';
import { AuthService } from '../../services/auth.service';
import { environments } from '../../../environments/environments';

@Component({
  selector: 'app-analyse',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownModule],
  templateUrl: './analyse.component.html',
  styleUrl: './analyse.component.css'
})
export class AnalyseComponent {
  enquiryText = signal('');
  analysisResult = signal<string | null>(null);
  isLoading = signal(false);
  errorMessage = signal('');
  copySuccess = signal<string | null>(null);
  matchedModel = signal<string | null>(null);
  warrantyMonths = signal<number | null>(null);
  detectedProduct = signal<string | null>(null);
  matchedCases = signal<number | null>(null);

  inputPanelWidth = signal(384); // px, default w-96
  private isResizing = false;

  private platformId = inject(PLATFORM_ID);
  private isBrowser = isPlatformBrowser(this.platformId);

  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  onResizeStart(event: MouseEvent) {
    if (!this.isBrowser) return;
    this.isResizing = true;
    event.preventDefault();

    const onMove = (e: MouseEvent) => {
      if (!this.isResizing) return;
      // Clamp between 240px and 640px
      const newWidth = Math.min(640, Math.max(240, e.clientX - 208)); // 208 = sidebar width
      this.inputPanelWidth.set(newWidth);
    };
    const onUp = () => {
      this.isResizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  async onAnalyse() {
    if (!this.isBrowser) return;

    const text = this.enquiryText().trim();
    if (!text) {
      this.errorMessage.set('Please enter an enquiry to analyse');
      return;
    }

    this.errorMessage.set('');
    this.analysisResult.set(null);
    this.matchedModel.set(null);
    this.warrantyMonths.set(null);
    this.detectedProduct.set(null);
    this.matchedCases.set(null);
    this.isLoading.set(true);

    try {
      const token = await this.authService.getIdToken();
      if (!token) {
        this.errorMessage.set('Authentication expired. Please sign in again.');
        this.router.navigate(['/auth']);
        return;
      }
      console.log('Sending analysis request with token:', token);

      const response = await fetch(`${environments.apiUrl}/analyse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text })
      });
      console.log('API response status:', response.status);

      if (!response.ok) {
        throw new Error('Analysis failed. Please try again.');
      }

      const data = await response.json();
      this.analysisResult.set(data.analysis);
      this.matchedModel.set(data.matchedModel || null);
      this.warrantyMonths.set(data.warrantyMonths || null);
      this.detectedProduct.set(data.detectedProduct || null);
      this.matchedCases.set(data.matchedCases ?? null);
      console.log('Analysis result:', data.analysis);
    } catch (error: any) {
      this.errorMessage.set(error.message || 'An error occurred during analysis');
    } finally {
      this.isLoading.set(false);
    }
  }

  async onSignOut() {
    await this.authService.signOut();
    this.router.navigate(['/auth']);
  }

  get userName() {
    return this.authService.currentUser()?.name || 'User';
  }

  extractSection(sectionTitle: string): string | null {
    const result = this.analysisResult();
    if (!result) return null;

    // Match the section header (e.g., **Suggested Email Response**:)
    const pattern = new RegExp(`\\*\\*${sectionTitle}\\*\\*[:\\s]*\\n`, 'i');
    const match = result.search(pattern);
    if (match === -1) return null;

    // Find where the content starts (after the header line)
    const startIndex = result.indexOf('\n', match) + 1;

    // Find where the next section starts (next **Title**: pattern or end)
    const nextSection = result.slice(startIndex).search(/^\d+\.\s+\*\*|^\*\*\[/m);
    const endIndex = nextSection === -1 ? result.length : startIndex + nextSection;

    return result.slice(startIndex, endIndex).trim();
  }

  stripMarkdown(text: string): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')   // **bold** → bold
      .replace(/\*(.*?)\*/g, '$1')        // *italic* → italic
      .replace(/^#{1,6}\s+/gm, '')        // ## heading → heading
      .replace(/^- /gm, '● ')            // - bullet → ● bullet
      .replace(/^\d+\.\s+/gm, (m) => m)  // keep numbered lists as-is
      .trim();
  }

  getDetectedMode(): string {
    const result = this.analysisResult();
    if (!result) return '';
    if (result.includes('[CUSTOMER SERVICE MODE]')) return 'Customer Service Mode';
    if (result.includes('[TECHNICIAN MODE]')) return 'Technician Mode';
    return '';
  }

  extractPriority(): string | null {
    const result = this.analysisResult();
    if (!result) return null;
    const match = result.match(/\*\*Priority\*\*[:\s]+([A-Za-z]+)/i);
    return match ? match[1] : null;
  }

  extractIssueCategory(): string | null {
    const result = this.analysisResult();
    if (!result) return null;
    const match = result.match(/\*\*Issue Category\*\*[:\s]+([^\n]+)/i);
    return match ? match[1].replace(/\*\*/g, '').trim() : null;
  }

  extractPurchaseDate(): string | null {
    const result = this.analysisResult();
    if (!result) return null;
    const match = result.match(/[Pp]urchase\s+[Dd]ate[:\s*-]+([^\n]+)/i);
    return match ? match[1].replace(/[*\-●]/g, '').trim() : null;
  }

  extractExpiryDate(): string | null {
    const result = this.analysisResult();
    if (!result) return null;
    const match = result.match(/[Ee]xpir[yi][a-z]*\s+[Dd]ate[:\s*-]+([^\n]+)/i);
    return match ? match[1].replace(/[*\-●]/g, '').trim() : null;
  }

  extractWarrantyStatus(): 'ACTIVE' | 'EXPIRED' | null {
    const result = this.analysisResult();
    if (!result) return null;
    if (/UNDER WARRANTY/i.test(result)) return 'ACTIVE';
    if (/OUT OF WARRANTY/i.test(result)) return 'EXPIRED';
    return null;
  }

  formatDate(dateStr: string | null): string {
    if (!dateStr) return '-';
    const m = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const date = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
      return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    return dateStr;
  }

  getWarrantyProgress(): number {
    const parseAU = (str: string | null) => {
      if (!str) return null;
      const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      return m ? new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1])).getTime() : null;
    };
    const start = parseAU(this.extractPurchaseDate());
    const end = parseAU(this.extractExpiryDate());
    if (!start || !end) return this.extractWarrantyStatus() === 'ACTIVE' ? 40 : 100;
    const now = Date.now();
    if (now >= end) return 100;
    if (now <= start) return 0;
    return Math.round(((now - start) / (end - start)) * 100);
  }

  getPriorityClass(): string {
    const priority = this.extractPriority()?.toLowerCase();
    const base = 'font-bold text-base leading-tight';
    if (priority === 'high') return `${base} text-red-500`;
    if (priority === 'medium') return `${base} text-orange-500`;
    if (priority === 'low') return `${base} text-green-500`;
    return `${base} text-gray-900`;
  }

  async copyToClipboard(content: string, label: string) {
    try {
      await navigator.clipboard.writeText(content);
      this.copySuccess.set(label);
      setTimeout(() => this.copySuccess.set(null), 2000);
    } catch {
      this.copySuccess.set('Failed to copy');
      setTimeout(() => this.copySuccess.set(null), 2000);
    }
  }
}

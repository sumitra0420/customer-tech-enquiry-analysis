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
  warrantyYears = signal<number | null>(null);
  detectedProduct = signal<string | null>(null);

  private platformId = inject(PLATFORM_ID);
  private isBrowser = isPlatformBrowser(this.platformId);

  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

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
    this.warrantyYears.set(null);
    this.detectedProduct.set(null);
    this.isLoading.set(true);

    try {
      const token = await this.authService.getIdToken();
      if (!token) {
        this.errorMessage.set('Authentication expired. Please sign in again.');
        this.router.navigate(['/auth']);
        return;
      }
      console.log('Sending analysis request with token:', token);

      const response = await fetch(`${environments.apiUrl}/enquiries/temp/analyse`, {
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
      this.warrantyYears.set(data.warrantyYears || null);
      this.detectedProduct.set(data.detectedProduct || null);
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

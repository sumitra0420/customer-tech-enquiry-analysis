import { Component, signal, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser, CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { environments } from '../../../environments/environments';

@Component({
  selector: 'app-analyse',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './analyse.component.html',
  styleUrl: './analyse.component.css'
})
export class AnalyseComponent {
  enquiryText = signal('');
  analysisResult = signal<string | null>(null);
  isLoading = signal(false);
  errorMessage = signal('');

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
    this.isLoading.set(true);

    try {
      const token = await this.authService.getIdToken();
      if (!token) {
        this.errorMessage.set('Authentication expired. Please sign in again.');
        this.router.navigate(['/auth']);
        return;
      }

      const response = await fetch(`${environments.apiUrl}/enquiries/temp/analyse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text })
      });

      if (!response.ok) {
        throw new Error('Analysis failed. Please try again.');
      }

      const data = await response.json();
      this.analysisResult.set(data.analysis);
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
}

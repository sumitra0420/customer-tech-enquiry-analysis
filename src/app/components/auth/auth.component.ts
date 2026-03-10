import { Component, signal, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser, CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './auth.component.html',
  styleUrl: './auth.component.css'
})
export class AuthComponent {
  isSignUp = signal(false);
  needsVerification = signal(false);
  showPasswordStep = signal(false);

  // Form fields
  name = signal('');
  email = signal('');
  password = signal('');
  confirmPassword = signal('');
  verificationCode = signal('');

  errorMessage = signal('');
  successMessage = signal('');
  isLoading = signal(false);

  private platformId = inject(PLATFORM_ID);
  private isBrowser = isPlatformBrowser(this.platformId);

  constructor(
    private authService: AuthService,
    private router: Router
  ) {
    // Check if user is already authenticated
    if (this.isBrowser && this.authService.isAuthenticated()) {
      this.router.navigate(['/analyse']);
    }
  }

  async signOutCurrent() {
    await this.authService.signOut();
    this.errorMessage.set('');
    this.successMessage.set('Signed out successfully. Please sign in again.');
  }

  async onSignIn() {
    if (!this.isBrowser) return;

    this.errorMessage.set('');
    this.isLoading.set(true);

    const result = await this.authService.signIn(this.email(), this.password());

    this.isLoading.set(false);

    if (result.success) {
      this.router.navigate(['/analyse']);
    } else {
      this.errorMessage.set(result.message);
    }
  }

  async onSignUp() {
    if (!this.isBrowser) return;

    this.errorMessage.set('');

    if (this.password() !== this.confirmPassword()) {
      this.errorMessage.set('Passwords do not match');
      return;
    }

    this.isLoading.set(true);

    const result = await this.authService.signUp(
      this.email(),
      this.password(),
      this.name()
    );

    this.isLoading.set(false);

    if (result.success) {
      this.successMessage.set(result.message);
      this.needsVerification.set(true);
    } else {
      this.errorMessage.set(result.message);
    }
  }

  async onVerify() {
    if (!this.isBrowser) return;

    this.errorMessage.set('');
    this.isLoading.set(true);

    const result = await this.authService.confirmSignUp(
      this.email(),
      this.verificationCode()
    );

    this.isLoading.set(false);

    if (result.success) {
      this.successMessage.set('Email verified! You can now sign in.');
      this.needsVerification.set(false);
      this.isSignUp.set(false);
    } else {
      this.errorMessage.set(result.message);
    }
  }

  continueWithEmail() {
    this.errorMessage.set('');
    if (!this.email().trim()) {
      this.errorMessage.set('Please enter your email address.');
      return;
    }
    this.showPasswordStep.set(true);
  }

  backToEmail() {
    this.showPasswordStep.set(false);
    this.password.set('');
    this.errorMessage.set('');
  }

  socialLogin(provider: string) {
    this.errorMessage.set(`${provider} login is not yet configured. Please use email to sign in.`);
  }

  toggleMode() {
    this.isSignUp.update(v => !v);
    this.errorMessage.set('');
    this.successMessage.set('');
    this.needsVerification.set(false);
    this.showPasswordStep.set(false);
  }
}

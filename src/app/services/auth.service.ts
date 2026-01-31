import { Injectable, signal, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  signIn,
  signUp,
  signOut,
  getCurrentUser,
  fetchAuthSession,
  confirmSignUp,
  SignUpInput,
  SignInInput,
  ConfirmSignUpInput,
} from 'aws-amplify/auth';

export interface CognitoUser {
  userId: string; // Cognito sub
  email: string;
  name: string;
}

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  // Signal to track authentication state
  currentUser = signal<CognitoUser | null>(null);
  isAuthenticated = signal<boolean>(false);

  private platformId = inject(PLATFORM_ID);
  private isBrowser = isPlatformBrowser(this.platformId);

  constructor() {
    if (this.isBrowser) {
      this.checkAuthStatus();
    }
  }

  /**
   * Check if user is already authenticated (on app load)
   */
  async checkAuthStatus(): Promise<void> {
    if (!this.isBrowser) return;

    try {
      const user = await getCurrentUser();
      const session = await fetchAuthSession();

      if (user && session.tokens) {
        const idToken = session.tokens.idToken;
        this.currentUser.set({
          userId: user.userId,
          email: idToken?.payload['email'] as string,
          name: idToken?.payload['name'] as string,
        });
        this.isAuthenticated.set(true);
      }
    } catch (error) {
      this.currentUser.set(null);
      this.isAuthenticated.set(false);
    }
  }

  /**
   * Sign up a new user
   */
  async signUp(email: string, password: string, name: string): Promise<{ success: boolean; message: string }> {
    try {
      const signUpInput: SignUpInput = {
        username: email,
        password,
        options: {
          userAttributes: {
            email,
            name,
          },
        },
      };

      const { isSignUpComplete, userId, nextStep } = await signUp(signUpInput);

      return {
        success: true,
        message: 'Sign up successful! Please check your email for verification code.',
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Sign up failed',
      };
    }
  }

  /**
   * Confirm sign up with verification code
   */
  async confirmSignUp(email: string, code: string): Promise<{ success: boolean; message: string }> {
    try {
      const confirmInput: ConfirmSignUpInput = {
        username: email,
        confirmationCode: code,
      };

      await confirmSignUp(confirmInput);

      return {
        success: true,
        message: 'Email verified successfully! You can now sign in.',
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Verification failed',
      };
    }
  }

  /**
   * Sign in a user
   */
  async signIn(email: string, password: string): Promise<{ success: boolean; message: string }> {
    try {
      const signInInput: SignInInput = {
        username: email,
        password,
      };

      const { isSignedIn, nextStep } = await signIn(signInInput);

      if (isSignedIn) {
        await this.checkAuthStatus();
        return {
          success: true,
          message: 'Sign in successful!',
        };
      }

      return {
        success: false,
        message: 'Sign in incomplete. Please complete additional steps.',
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Sign in failed',
      };
    }
  }

  /**
   * Sign out the current user
   */
  async signOut(): Promise<void> {
    try {
      await signOut();
      this.currentUser.set(null);
      this.isAuthenticated.set(false);
    } catch (error) {
      console.error('Sign out failed:', error);
    }
  }

  /**
   * Get the current user's JWT token for API calls
   */
  async getIdToken(): Promise<string | null> {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.idToken?.toString() || null;
    } catch (error) {
      return null;
    }
  }
}

import { inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const platformId = inject(PLATFORM_ID);
  console.log('AuthGuard: Checking authentication status...');

  // Skip auth check on server
  if (!isPlatformBrowser(platformId)) {
    console.log('AuthGuard: Running on server, skipping auth check.');
    return true;
  }

  if (authService.isAuthenticated()) {
    console.log('AuthGuard: User is authenticated, allowing access.');
    return true;
  }
  console.log('AuthGuard: User is not authenticated, redirecting to /auth.');

  router.navigate(['/auth']);
  return false;
};

export const redirectIfAuthenticatedGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const platformId = inject(PLATFORM_ID);
  console.log('RedirectIfAuthenticatedGuard: Checking authentication status...');

  // Skip auth check on server
  if (!isPlatformBrowser(platformId)) {
    return true;
  }

  return authService.checkAuthStatus().then(() => {
    if (authService.isAuthenticated()) {
      router.navigate(['/analyse']);
      return false;
    }
    return true;
  });
};

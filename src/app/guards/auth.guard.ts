import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated()) {
    return true;
  }
  console.log('User is not authenticated, redirecting to auth page.');

  router.navigate(['/auth']);
  return false;
};

export const redirectIfAuthenticatedGuard = async () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Wait for auth check to complete
  await authService.checkAuthStatus();

  if (authService.isAuthenticated()) {
    console.log('User is authenticated, redirecting to home page.');
    router.navigate(['']);
    return false;
  }

  return true;
};

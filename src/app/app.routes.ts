import { Routes } from '@angular/router';
import { authGuard, redirectIfAuthenticatedGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: '/auth',
    pathMatch: 'full'
  },
  {
    path: 'auth',
    loadComponent: () => import('./components/auth/auth.component').then(m => m.AuthComponent),
    canActivate: [redirectIfAuthenticatedGuard]
  },
  {
    path: 'analyse',
    loadComponent: () => import('./components/analyse/analyse.component').then(m => m.AnalyseComponent),
    canActivate: [authGuard]
  },
];

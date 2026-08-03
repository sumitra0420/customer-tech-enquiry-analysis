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
  {
    path: 'manual',
    loadComponent: () => import('./components/manual/manual.component').then(m => m.ManualComponent),
    canActivate: [authGuard]
  },
  {
    path: 'faults',
    loadComponent: () => import('./components/faults/faults.component').then(m => m.FaultsComponent),
    canActivate: [authGuard]
  },
];

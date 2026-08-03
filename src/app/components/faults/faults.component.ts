import { Component, signal, computed, PLATFORM_ID, inject, OnInit, OnDestroy } from '@angular/core';
import { isPlatformBrowser, CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { environments } from '../../../environments/environments';

interface ModelSuggestion {
  model: string;
  productName: string | null;
  productType: string | null;
}

interface FaultCategory {
  name: string;
  count: number;
}

interface RecentJob {
  jobNumber: string;
  dateOpened: string | null;
  customerComment: string | null;
  technicianComment: string | null;
  jobAction: string | null;
  status: string | null;
  stage: string | null;
  category: string;
  outcome: string;
}

interface FaultsDashboardResponse {
  model: string;
  productName: string | null;
  warrantyMonths: number | null;
  productType: string | null;
  status: string;
  kpis: {
    totalJobs: number;
    allModelsTotalJobs: number;
    sharePercent: number;
    earliestDate: string | null;
    mostRecentDate: string | null;
    mostRecentJobNumber: string | null;
  };
  trend: { months: string[]; counts: number[] };
  faultCategories: FaultCategory[];
  technicianOutcomes: FaultCategory[];
  sdCardWarning: { show: boolean; count: number; percentage: number };
  sampleInfo: { sampleSize: number; truncated: boolean };
  recentJobs: RecentJob[];
}

const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#9ca3af'];

const FILTER_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'power', label: '⚡ Power' },
  { key: 'recording', label: '🎬 Recording' },
  { key: 'display', label: '🖥 Display' },
  { key: 'connection', label: '📡 Connection' },
  { key: 'hardware', label: '🔧 Hardware' },
];

@Component({
  selector: 'app-faults',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './faults.component.html',
})
export class FaultsComponent implements OnInit, OnDestroy {
  filterChips = FILTER_CHIPS;

  searchQuery = signal('');
  suggestions = signal<ModelSuggestion[]>([]);
  recentSearches = signal<string[]>([]);
  selectedModel = signal<string | null>(null);
  dashboardData = signal<FaultsDashboardResponse | null>(null);
  isLoading = signal(false);
  errorMessage = signal('');
  activeFilterChip = signal<string>('all');
  dbStatus = signal<'checking' | 'connected' | 'offline'>('checking');

  filteredJobs = computed(() => {
    const data = this.dashboardData();
    if (!data) return [];
    const chip = this.activeFilterChip();
    if (chip === 'all') return data.recentJobs;
    return data.recentJobs.filter(j => (j.category || '').toLowerCase().includes(chip));
  });

  private platformId = inject(PLATFORM_ID);
  private isBrowser = isPlatformBrowser(this.platformId);
  private warmupInterval: any = null;
  private searchDebounce: any = null;
  private ChartCtor: any = null;
  private faultChart: any = null;
  private trendChart: any = null;
  private outcomeChart: any = null;

  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  ngOnInit() {
    if (!this.isBrowser) return;
    this.pingWarmup();
    this.warmupInterval = setInterval(() => this.pingWarmup(), 2 * 60 * 1000);
  }

  ngOnDestroy() {
    if (this.warmupInterval) clearInterval(this.warmupInterval);
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.faultChart?.destroy();
    this.trendChart?.destroy();
    this.outcomeChart?.destroy();
  }

  private async pingWarmup() {
    try {
      const res = await fetch(`${environments.apiUrl}/warmup`);
      this.dbStatus.set(res.ok ? 'connected' : 'offline');
    } catch {
      this.dbStatus.set('offline');
    }
  }

  get userName() {
    return this.authService.currentUser()?.name || 'User';
  }

  async onSignOut() {
    await this.authService.signOut();
    this.router.navigate(['/auth']);
  }

  onSearchInput() {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    const query = this.searchQuery().trim();
    if (query.length < 2) {
      this.suggestions.set([]);
      return;
    }
    this.searchDebounce = setTimeout(() => this.fetchSuggestions(query), 250);
  }

  private async fetchSuggestions(query: string) {
    if (!this.isBrowser) return;
    try {
      const token = await this.authService.getIdToken();
      const res = await fetch(`${environments.apiUrl}/faults/search?q=${encodeURIComponent(query)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const data = await res.json();
      this.suggestions.set(data.results || []);
    } catch {
      // ignore — autocomplete is best-effort
    }
  }

  onSearchSubmit() {
    const query = this.searchQuery().trim();
    if (!query) return;
    this.selectModel(query.toUpperCase());
  }

  selectModel(model: string) {
    this.searchQuery.set(model);
    this.suggestions.set([]);
    this.selectedModel.set(model);
    const recents = this.recentSearches().filter(m => m !== model);
    this.recentSearches.set([model, ...recents].slice(0, 5));
    this.loadDashboard();
  }

  async loadDashboard() {
    if (!this.isBrowser) return;
    const model = this.selectedModel();
    if (!model) return;

    this.isLoading.set(true);
    this.errorMessage.set('');
    this.dashboardData.set(null);
    this.activeFilterChip.set('all');

    try {
      const token = await this.authService.getIdToken();
      if (!token) {
        this.errorMessage.set('Authentication expired. Please sign in again.');
        this.router.navigate(['/auth']);
        return;
      }

      const response = await fetch(`${environments.apiUrl}/faults?model=${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.errorMessage.set(`No repair jobs found for "${model}"`);
          return;
        }
        if (response.status === 429) {
          this.errorMessage.set('The system is receiving too many requests right now. Please wait a moment and try again.');
          return;
        }
        throw new Error('Service is temporarily unavailable. Please wait a moment and try again.');
      }

      const data: FaultsDashboardResponse = await response.json();
      this.dashboardData.set(data);
      await this.renderCharts();
    } catch (error: any) {
      this.errorMessage.set(error.message || 'An error occurred while loading the dashboard');
    } finally {
      this.isLoading.set(false);
    }
  }

  setFilterChip(key: string) {
    this.activeFilterChip.set(key);
  }

  formatDate(dateStr: string | null): string {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  periodLabel(): string {
    const kpis = this.dashboardData()?.kpis;
    if (!kpis?.earliestDate || !kpis?.mostRecentDate) return 'No data';
    const start = new Date(kpis.earliestDate);
    const end = new Date(kpis.mostRecentDate);
    const months = Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);
    const fmt = (d: Date) => d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
    return `${fmt(start)} – ${fmt(end)} · ${months} month${months === 1 ? '' : 's'}`;
  }

  faultConfirmedRate(): number {
    const outcomes = this.dashboardData()?.technicianOutcomes || [];
    const total = outcomes.reduce((sum, o) => sum + o.count, 0);
    if (total === 0) return 0;
    const confirmed = outcomes.find(o => o.name === 'Fault Confirmed')?.count || 0;
    return Math.round((confirmed / total) * 100);
  }

  faultConfirmedCount(): number {
    return this.dashboardData()?.technicianOutcomes.find(o => o.name === 'Fault Confirmed')?.count || 0;
  }

  outcomesTotal(): number {
    return (this.dashboardData()?.technicianOutcomes || []).reduce((sum, o) => sum + o.count, 0);
  }

  categoryTagClass(category: string): string {
    const c = (category || '').toLowerCase();
    if (c.includes('power')) return 'bg-blue-50 text-blue-700';
    if (c.includes('recording')) return 'bg-orange-50 text-orange-700';
    if (c.includes('display')) return 'bg-green-50 text-green-700';
    if (c.includes('connection')) return 'bg-amber-50 text-amber-800';
    if (c.includes('hardware')) return 'bg-purple-50 text-purple-700';
    if (c.includes('overheat')) return 'bg-emerald-50 text-emerald-900';
    return 'bg-gray-100 text-gray-600';
  }

  outcomeBadgeClass(outcome: string): string {
    if (outcome === 'Fault Confirmed') return 'bg-red-100 text-red-800';
    if (outcome === 'Firmware Update Fixed It') return 'bg-blue-50 text-blue-800';
    if (outcome === 'SD Card Issue') return 'bg-amber-50 text-amber-800';
    return 'bg-gray-100 text-gray-700';
  }

  exportCsv() {
    const jobs = this.filteredJobs();
    if (jobs.length === 0) return;
    const header = ['Job #', 'Date', 'Customer Issue', 'Technician Outcome'];
    const rows = jobs.map(j => [j.jobNumber, this.formatDate(j.dateOpened), j.category, j.outcome]);
    const csv = [header, ...rows]
      .map(row => row.map(field => `"${String(field ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.dashboardData()?.model || 'faults'}-jobs.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async ensureChartJs() {
    if (!this.isBrowser) return null;
    if (!this.ChartCtor) {
      const mod = await import('chart.js');
      mod.Chart.register(...mod.registerables);
      this.ChartCtor = mod.Chart;
    }
    return this.ChartCtor;
  }

  private async renderCharts() {
    const data = this.dashboardData();
    if (!data || !this.isBrowser) return;

    const Chart = await this.ensureChartJs();
    if (!Chart) return;

    // Let Angular finish rendering the canvases before we grab them.
    await new Promise(resolve => setTimeout(resolve, 0));

    this.faultChart?.destroy();
    this.trendChart?.destroy();
    this.outcomeChart?.destroy();

    const catCanvas = document.getElementById('faultCatChart') as HTMLCanvasElement | null;
    if (catCanvas) {
      const categories = data.faultCategories;
      this.faultChart = new Chart(catCanvas, {
        type: 'bar',
        data: {
          labels: categories.map(c => c.name),
          datasets: [{
            data: categories.map(c => c.count),
            backgroundColor: categories.map((_, i) => SERIES_COLORS[i % SERIES_COLORS.length]),
            borderRadius: 4,
            borderSkipped: false,
            barThickness: 16,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#e1e0d9' }, ticks: { color: '#898781' } },
            y: { grid: { display: false }, ticks: { color: '#4b5563', font: { size: 11 } } },
          },
        },
      });
    }

    const trendCanvas = document.getElementById('trendChart') as HTMLCanvasElement | null;
    if (trendCanvas) {
      this.trendChart = new Chart(trendCanvas, {
        type: 'line',
        data: {
          labels: data.trend.months,
          datasets: [{
            data: data.trend.counts,
            borderColor: '#2a78d6',
            backgroundColor: 'rgba(42,120,214,0.08)',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#2a78d6',
            tension: 0.35,
            fill: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#898781', maxRotation: 45, font: { size: 10 } } },
            y: { grid: { color: '#e1e0d9' }, ticks: { color: '#898781', stepSize: 1 }, min: 0 },
          },
        },
      });
    }

    const outcomeCanvas = document.getElementById('outcomeMiniChart') as HTMLCanvasElement | null;
    if (outcomeCanvas) {
      const outcomes = data.technicianOutcomes;
      this.outcomeChart = new Chart(outcomeCanvas, {
        type: 'bar',
        data: {
          labels: outcomes.map(o => o.name),
          datasets: [{
            data: outcomes.map(o => o.count),
            backgroundColor: SERIES_COLORS[0],
            borderRadius: 4,
            barThickness: 12,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#e1e0d9' }, ticks: { color: '#898781', font: { size: 10 } } },
            y: { grid: { display: false }, ticks: { color: '#4b5563', font: { size: 10 } } },
          },
        },
      });
    }
  }
}

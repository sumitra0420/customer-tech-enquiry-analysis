import { Component, signal, PLATFORM_ID, inject, ElementRef, ViewChild } from '@angular/core';
import { isPlatformBrowser, CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { environments } from '../../../environments/environments';

interface ReceiptData {
  store_name: string | null;
  customer_name: string | null;
  product_name: string | null;
  model_number: string | null;
  purchase_date: string | null;
  total_price: string | null;
  receipt_number: string | null;
}

@Component({
  selector: 'app-receipt-scanner',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './receipt-scanner.component.html',
  styleUrl: './receipt-scanner.component.css'
})
export class ReceiptScannerComponent {
  @ViewChild('videoEl') videoEl!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasEl') canvasEl!: ElementRef<HTMLCanvasElement>;
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  private platformId = inject(PLATFORM_ID);
  private isBrowser = isPlatformBrowser(this.platformId);

  step = signal<'capture' | 'review' | 'done'>('capture');
  isExtracting = signal(false);
  isSaving = signal(false);
  errorMessage = signal('');
  saveSuccess = signal(false);
  savedId = signal<number | null>(null);

  capturedImage = signal<string | null>(null); // base64 JPEG
  previewUrl = signal<string | null>(null);

  receiptData = signal<ReceiptData>({
    store_name: null,
    customer_name: null,
    product_name: null,
    model_number: null,
    purchase_date: null,
    total_price: null,
    receipt_number: null,
  });

  private stream: MediaStream | null = null;
  cameraActive = signal(false);
  cameraError = signal('');

  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  get userName() {
    return this.authService.currentUser()?.name || 'User';
  }

  async onSignOut() {
    await this.authService.signOut();
    this.router.navigate(['/auth']);
  }

  async startCamera() {
    if (!this.isBrowser) return;
    this.cameraError.set('');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      this.cameraActive.set(true);
      // Give the DOM time to show the video element
      setTimeout(() => {
        if (this.videoEl?.nativeElement && this.stream) {
          this.videoEl.nativeElement.srcObject = this.stream;
        }
      }, 50);
    } catch (err: any) {
      this.cameraError.set('Camera access denied. Please use file upload instead.');
    }
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.cameraActive.set(false);
  }

  capturePhoto() {
    if (!this.isBrowser) return;
    const video = this.videoEl?.nativeElement;
    const canvas = this.canvasEl?.nativeElement;
    if (!video || !canvas) return;

    // Scale down to max 1280px wide to keep payload small
    const MAX_W = 1280;
    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w > MAX_W) { h = Math.round((h * MAX_W) / w); w = MAX_W; }
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',')[1];

    this.capturedImage.set(base64);
    this.previewUrl.set(dataUrl);
    this.stopCamera();
    this.extractReceipt('image/jpeg');
  }

  onFileSelected(event: Event) {
    if (!this.isBrowser) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Compress via canvas
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_W = 1280;
        let w = img.width, h = img.height;
        if (w > MAX_W) { h = Math.round((h * MAX_W) / w); w = MAX_W; }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const base64 = compressedDataUrl.split(',')[1];
        this.capturedImage.set(base64);
        this.previewUrl.set(compressedDataUrl);
        this.extractReceipt('image/jpeg');
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  private async extractReceipt(mediaType: string) {
    this.isExtracting.set(true);
    this.errorMessage.set('');
    this.step.set('review');

    try {
      const token = await this.authService.getIdToken();
      if (!token) { this.router.navigate(['/auth']); return; }

      const response = await fetch(`${environments.apiUrl}/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'extract', image: this.capturedImage(), mediaType })
      });

      if (!response.ok) throw new Error('Extraction failed');
      const data = await response.json();
      this.receiptData.set(data.extracted || {});
    } catch (err: any) {
      this.errorMessage.set(err.message || 'Failed to extract receipt data');
    } finally {
      this.isExtracting.set(false);
    }
  }

  updateField(field: keyof ReceiptData, value: string) {
    this.receiptData.update(d => ({ ...d, [field]: value || null }));
  }

  async saveReceipt() {
    this.isSaving.set(true);
    this.errorMessage.set('');

    try {
      const token = await this.authService.getIdToken();
      if (!token) { this.router.navigate(['/auth']); return; }

      const response = await fetch(`${environments.apiUrl}/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          action: 'save',
          receiptData: this.receiptData(),
          uploadedBy: this.userName
        })
      });

      if (!response.ok) throw new Error('Save failed');
      const data = await response.json();
      this.savedId.set(data.id);
      this.saveSuccess.set(true);
      this.step.set('done');
    } catch (err: any) {
      this.errorMessage.set(err.message || 'Failed to save receipt');
    } finally {
      this.isSaving.set(false);
    }
  }

  resetScanner() {
    this.step.set('capture');
    this.capturedImage.set(null);
    this.previewUrl.set(null);
    this.saveSuccess.set(false);
    this.savedId.set(null);
    this.errorMessage.set('');
    this.cameraError.set('');
    this.receiptData.set({
      store_name: null, customer_name: null, product_name: null,
      model_number: null, purchase_date: null, total_price: null, receipt_number: null,
    });
    if (this.fileInput?.nativeElement) this.fileInput.nativeElement.value = '';
  }
}

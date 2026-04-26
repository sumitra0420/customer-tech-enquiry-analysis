import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-manual',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './manual.component.html',
})
export class ManualComponent {
  copiedText: string | null = null;

  copy(text: string) {
    this.copiedText = text;
    setTimeout(() => { this.copiedText = null; }, 600);
    navigator.clipboard?.writeText(text);
  }
}

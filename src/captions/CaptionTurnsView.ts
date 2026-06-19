import { CaptionTurn } from './CaptionTurn';
import { CaptionTurnStore, CaptionTurnStoreSnapshot } from './CaptionTurnStore';

export interface CaptionTurnsViewOptions {
  store: CaptionTurnStore;
  container: HTMLElement;
  autoScrollTolerancePx?: number;
}

export class CaptionTurnsView {
  private readonly store: CaptionTurnStore;
  private readonly container: HTMLElement;
  private readonly autoScrollTolerancePx: number;
  private shouldAutoScroll = true;
  private unsubscribe: (() => void) | null = null;

  constructor(options: CaptionTurnsViewOptions) {
    this.store = options.store;
    this.container = options.container;
    this.autoScrollTolerancePx = options.autoScrollTolerancePx ?? 32;
  }

  mount(): void {
    this.container.classList.add('caption-turns');
    this.container.addEventListener('scroll', this.handleScroll, { passive: true });
    this.unsubscribe = this.store.subscribe((snapshot) => this.render(snapshot));
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.container.removeEventListener('scroll', this.handleScroll);
    this.container.replaceChildren();
  }

  private render(snapshot: CaptionTurnStoreSnapshot): void {
    const turns = snapshot.activeTurn
      ? [...snapshot.finalizedTurns, snapshot.activeTurn]
      : snapshot.finalizedTurns;

    const fragment = document.createDocumentFragment();
    turns.forEach((turn) => fragment.appendChild(renderCaptionTurn(turn, turn.id === snapshot.activeTurn?.id)));
    this.container.replaceChildren(fragment);

    if (this.shouldAutoScroll) {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  private handleScroll = (): void => {
    const distanceFromBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
    this.shouldAutoScroll = distanceFromBottom <= this.autoScrollTolerancePx;
  };
}

export function renderCaptionTurn(turn: CaptionTurn, isActive = false): HTMLElement {
  const block = document.createElement('article');
  block.className = `caption-turn caption-turn--${turn.speakerKind}`;
  block.dataset.captionTurnId = turn.id;
  block.dataset.interim = String(turn.isInterim);
  block.dataset.active = String(isActive);

  const speaker = document.createElement('div');
  speaker.className = 'caption-turn__speaker';
  speaker.textContent = turn.speakerLabel;

  const text = document.createElement('p');
  text.className = 'caption-turn__text';
  text.textContent = turn.text;

  block.append(speaker, text);
  return block;
}

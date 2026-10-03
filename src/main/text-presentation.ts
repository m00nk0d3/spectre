import { randomUUID } from "node:crypto";
import type {
  TextPresentation,
  TextPresentationKind,
} from "@/types/text-presentation";

type PresentationEmitter = (presentation: TextPresentation) => void;

interface PresentOptions {
  kind?: TextPresentationKind;
  title: string;
  content: string;
}

interface ConfirmOptions extends PresentOptions {
  spokenHint: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export class TextPresentationService {
  private emitter: PresentationEmitter | null = null;
  private pending = new Map<string, (accepted: boolean) => void>();

  setEmitter(emitter: PresentationEmitter | null): void {
    this.emitter = emitter;
    if (!emitter) this.cancelAll();
  }

  present(options: PresentOptions): TextPresentation {
    const presentation = this.createPresentation(options, false);
    this.requireEmitter()(presentation);
    return presentation;
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    const emit = this.requireEmitter();
    const presentation = this.createPresentation(options, true);
    presentation.spokenHint = options.spokenHint;
    presentation.confirmLabel = options.confirmLabel ?? "Confirm";
    presentation.cancelLabel = options.cancelLabel ?? "Cancel";

    return new Promise<boolean>((resolve) => {
      this.pending.set(presentation.id, resolve);
      try {
        emit(presentation);
      } catch {
        this.pending.delete(presentation.id);
        resolve(false);
      }
    });
  }

  respond(id: string, accepted: boolean): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve(accepted);
    return true;
  }

  cancelAll(): void {
    for (const resolve of this.pending.values()) resolve(false);
    this.pending.clear();
  }

  private createPresentation(
    options: PresentOptions,
    requiresResponse: boolean,
  ): TextPresentation {
    const title = options.title.trim();
    const content = options.content.trim();
    if (!title) throw new Error("Presentation title cannot be empty");
    if (!content) throw new Error("Presentation content cannot be empty");
    return {
      id: randomUUID(),
      kind: options.kind ?? "information",
      title,
      content,
      requiresResponse,
    };
  }

  private requireEmitter(): PresentationEmitter {
    if (!this.emitter) {
      throw new Error("Text presentation surface is not available");
    }
    return this.emitter;
  }
}

export const textPresentationService = new TextPresentationService();

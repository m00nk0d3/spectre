export type TextPresentationKind =
  | "confirmation"
  | "question"
  | "instructions"
  | "information";

export interface TextPresentation {
  id: string;
  kind: TextPresentationKind;
  title: string;
  content: string;
  spokenHint?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  requiresResponse: boolean;
}

export interface TextPresentationResponse {
  id: string;
  accepted: boolean;
}

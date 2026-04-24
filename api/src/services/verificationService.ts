import { BitMindClient, BitMindDetectImageResponse } from "../clients/bitmindClient";
import { ITSAI_MIN_TEXT_LENGTH, ItsAiClient, ItsAiDetectResponse } from "../clients/itsAiClient";
import { FetchMeta, PostMedia, XPostDetails } from "../types";
import { XPostService } from "./xPostService";

export interface ImageVerification {
  mediaUrl: string;
  status: "analyzed" | "failed";
  result?: BitMindDetectImageResponse;
  error?: { code: string; message: string };
}

export interface SkippedMedia {
  mediaUrl: string;
  type: PostMedia["type"];
  reason: string;
}

export interface TextVerification {
  status: "analyzed" | "skipped" | "failed" | "empty";
  characterCount: number;
  skippedReason?: string;
  result?: ItsAiDetectResponse;
  error?: { code: string; message: string };
}

export interface VerificationSummary {
  totalMedia: number;
  analyzedCount: number;
  skippedCount: number;
  failedCount: number;
  /** True if any analyzed image indicates AI (BitMind). Null if no image was analyzed. */
  anyAiMedia: boolean | null;
  maxConfidence: number | null;
  textOnly: boolean;
  /** ItsAI `answer` when text was analyzed (typically 0 = human, 1 = AI — confirm with subnet docs). */
  textAnswer: number | null;
  /** True when text was analyzed and answer indicates AI; null if text not analyzed. */
  anyAiText: boolean | null;
  /** Combined: true if any analyzed modality suggests AI. */
  anyAi: boolean | null;
}

export interface VerificationResult {
  post: XPostDetails;
  meta: FetchMeta;
  verification: {
    images: ImageVerification[];
    skipped: SkippedMedia[];
    text: TextVerification;
    summary: VerificationSummary;
  };
}

export class VerificationService {
  constructor(
    private readonly xPostService: XPostService,
    private readonly bitmind: BitMindClient,
    private readonly itsAi: ItsAiClient
  ) {}

  async verify(url: string): Promise<VerificationResult> {
    const { post, meta } = await this.xPostService.getPostDetails(url);

    const images: ImageVerification[] = [];
    const skipped: SkippedMedia[] = [];

    for (const media of post.media) {
      if (media.type !== "image") {
        skipped.push({
          mediaUrl: media.url,
          type: media.type,
          reason:
            media.type === "video"
              ? "Video analysis not implemented in v1 (detect-video pending)"
              : "Animated GIF not analyzed via detect-image in v1"
        });
        continue;
      }

      try {
        const result = await this.bitmind.detectImage(media.url);
        images.push({ mediaUrl: media.url, status: "analyzed", result });
      } catch (error) {
        const err = error as { code?: string; message?: string };
        images.push({
          mediaUrl: media.url,
          status: "failed",
          error: {
            code: err.code ?? "BITMIND_ERROR",
            message: err.message ?? "Failed to analyze image"
          }
        });
      }
    }

    const text = await this.verifyText(post.text);

    return {
      post,
      meta,
      verification: {
        images,
        skipped,
        text,
        summary: this.summarize(post, images, skipped, text)
      }
    };
  }

  private async verifyText(rawText: string): Promise<TextVerification> {
    const text = rawText.trim();
    const characterCount = text.length;

    if (characterCount === 0) {
      return { status: "empty", characterCount: 0 };
    }

    if (characterCount < ITSAI_MIN_TEXT_LENGTH) {
      return {
        status: "skipped",
        characterCount,
        skippedReason: `ItsAI requires at least ${ITSAI_MIN_TEXT_LENGTH} characters; post text is shorter`
      };
    }

    try {
      const result = await this.itsAi.detectText(text);
      return { status: "analyzed", characterCount, result };
    } catch (error) {
      const err = error as { code?: string; message?: string };
      return {
        status: "failed",
        characterCount,
        error: {
          code: err.code ?? "ITSAI_ERROR",
          message: err.message ?? "Failed to analyze text"
        }
      };
    }
  }

  private summarize(
    post: XPostDetails,
    images: ImageVerification[],
    skipped: SkippedMedia[],
    text: TextVerification
  ): VerificationSummary {
    const analyzed = images.filter((i) => i.status === "analyzed");
    const failed = images.filter((i) => i.status === "failed");

    const aiFlags = analyzed
      .map((i) => i.result?.isAI ?? i.result?.isAi)
      .filter((v): v is boolean => typeof v === "boolean");

    const confidences = analyzed
      .map((i) => i.result?.confidence)
      .filter((v): v is number => typeof v === "number");

    const anyAiMedia = aiFlags.length ? aiFlags.some((v) => v) : null;

    let textAnswer: number | null = null;
    let anyAiText: boolean | null = null;
    if (text.status === "analyzed" && text.result) {
      textAnswer = text.result.answer;
      anyAiText = text.result.answer === 1;
    }

    const signals: boolean[] = [];
    if (anyAiMedia === true || anyAiMedia === false) signals.push(anyAiMedia);
    if (anyAiText === true || anyAiText === false) signals.push(anyAiText);
    const anyAi = signals.length ? signals.some(Boolean) : null;

    return {
      totalMedia: post.media.length,
      analyzedCount: analyzed.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      anyAiMedia,
      maxConfidence: confidences.length ? Math.max(...confidences) : null,
      textOnly: post.media.length === 0,
      textAnswer,
      anyAiText,
      anyAi
    };
  }
}

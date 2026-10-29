import { z } from 'zod';
import { MemberHandle } from './member';
import type { HumanAccess } from './member';
import { feedbackOriginRefusal } from './feedback-origin';
import { TaskKey } from './task';

/**
 * Feedback marks (PM-506): a person marks a spot on a page of the product, writes a comment, and
 * the project's processor decides what comes of it. The contract of the marks, their views and
 * their requests; the pure rules are in `feedback-rules`.
 */

const FEEDBACK_MARK_KINDS = ['point', 'area', 'element', 'page'] as const;
const FEEDBACK_STATUSES = ['new', 'waiting_owner', 'handled', 'closed'] as const;
const FEEDBACK_OUTCOMES = ['card_created', 'card_linked', 'answered'] as const;
const FEEDBACK_EVENT_TYPES = [
  'comment',
  'card_created',
  'card_linked',
  'forwarded',
  'closed',
  'reopened',
] as const;

export const FeedbackMarkKind = z.enum(FEEDBACK_MARK_KINDS);
export type FeedbackMarkKind = z.infer<typeof FeedbackMarkKind>;
export const FeedbackStatus = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;
export const FeedbackOutcome = z.enum(FEEDBACK_OUTCOMES);
export type FeedbackOutcome = z.infer<typeof FeedbackOutcome>;
export const FeedbackEventType = z.enum(FEEDBACK_EVENT_TYPES);
export type FeedbackEventType = z.infer<typeof FeedbackEventType>;

export const FeedbackMarkId = z.string().regex(/^fbm_[a-z0-9]{10,32}$/);
export type FeedbackMarkId = z.infer<typeof FeedbackMarkId>;
const FeedbackSurfaceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
type FeedbackSurfaceId = z.infer<typeof FeedbackSurfaceId>;

const frac = z.number().min(0).max(1);
const coord = z.number().min(0).max(1_000_000);
/** A rectangle as fractions of a box (x/y from its corner; the far edge may sit a rounding hair past 1). */
const fracRect = z.strictObject({ x: frac, y: frac, width: frac, height: frac });
const FRAC_ROUNDING = 1.001;

/** Where on the page a mark sits; which fields are set depends on the kind (see the refinement). */
export const FeedbackAnchor = z
  .strictObject({
    kind: FeedbackMarkKind,
    selector: z.string().min(1).max(1000).nullable(),
    textSnippet: z.string().max(120).nullable(),
    /** Within the element's box. */
    elementOffset: z.strictObject({ x: frac, y: frac }).nullable(),
    /** Document coordinates. */
    pagePoint: z.strictObject({ x: coord, y: coord }).nullable(),
    rect: z.strictObject({ x: coord, y: coord, width: coord, height: coord }).nullable(),
    /**
     * An area's rectangle within its element's box, as fractions of the box (PM-917). Absent in older
     * marks: absent counts as null.
     */
    elementRect: fracRect.nullable().optional(),
  })
  .superRefine((anchor, ctx) => {
    type Field = 'selector' | 'elementOffset' | 'pagePoint' | 'rect' | 'elementRect';
    const need = (field: Field) => {
      if (anchor[field] == null) ctx.addIssue({ code: 'custom', path: [field], message: 'required' });
    };
    const forbid = (field: Field) => {
      if (anchor[field] != null) ctx.addIssue({ code: 'custom', path: [field], message: 'not allowed' });
    };
    // Both or neither: a point or area is pinned to an element only with all of the element's fields.
    const together = (present: Field, partner: Field) => {
      if (anchor[present] != null) need(partner);
    };
    switch (anchor.kind) {
      case 'point':
        need('pagePoint');
        together('selector', 'elementOffset');
        together('elementOffset', 'selector');
        forbid('elementRect');
        break;
      case 'area': {
        need('rect');
        if (anchor.rect && (anchor.rect.width < 4 || anchor.rect.height < 4))
          ctx.addIssue({ code: 'custom', path: ['rect'], message: 'too small' });
        together('selector', 'elementRect');
        together('elementRect', 'selector');
        const inside = anchor.elementRect;
        if (inside && (inside.x + inside.width > FRAC_ROUNDING || inside.y + inside.height > FRAC_ROUNDING))
          ctx.addIssue({ code: 'custom', path: ['elementRect'], message: 'outside element' });
        break;
      }
      case 'element':
        need('selector');
        need('elementOffset');
        need('pagePoint');
        forbid('elementRect');
        break;
      case 'page':
        forbid('selector');
        forbid('elementOffset');
        forbid('pagePoint');
        forbid('rect');
        forbid('elementRect');
        if (anchor.textSnippet !== null)
          ctx.addIssue({ code: 'custom', path: ['textSnippet'], message: 'not allowed' });
        break;
    }
  });
export type FeedbackAnchor = z.infer<typeof FeedbackAnchor>;

/** What the browser looked like when the mark was made (processors only see it). */
export const FeedbackEnvironment = z.strictObject({
  viewport: z.strictObject({
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000),
  }),
  scroll: z.strictObject({ x: coord, y: coord }),
  devicePixelRatio: z.number().min(0.25).max(8),
  userAgent: z.string().max(500),
  browser: z.string().max(60),
  os: z.string().max(60),
  language: z.string().max(35),
});
export type FeedbackEnvironment = z.infer<typeof FeedbackEnvironment>;

/** The decoded screenshot is at most this many bytes (else 413 `feedback_screenshot_too_large`). */
export const MAX_FEEDBACK_SCREENSHOT_BYTES = 2_000_000;
const FEEDBACK_SCREENSHOT_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const FeedbackScreenshotUpload = z.strictObject({
  mediaType: z.enum(FEEDBACK_SCREENSHOT_MEDIA_TYPES),
  /** Base64 of at most `MAX_FEEDBACK_SCREENSHOT_BYTES` bytes. */
  dataBase64: z.string().max(2_700_000),
});
export type FeedbackScreenshotUpload = z.infer<typeof FeedbackScreenshotUpload>;

export interface FeedbackScreenshotMeta {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  size: number;
  width: number;
  height: number;
}

/** A person in a mark or its thread; `color` is a marker colour (0..7) of a human, else null. */
export interface FeedbackPerson {
  handle: MemberHandle;
  name: string;
  kind: 'human' | 'ai';
  color: number | null;
}

/** The card of a mark. `visible` stays `true` for widgets loaded before PM-987. */
export interface FeedbackCardRef {
  visible: true;
  key: TaskKey;
  title: string;
  stageName: string;
}

/** `name` null: the surface was removed from the configuration since the mark was made. */
export interface FeedbackSurfaceView {
  id: string;
  name: string | null;
  origin: string;
}

export interface FeedbackMarkView {
  id: string;
  projectKey: string;
  author: FeedbackPerson;
  surface: FeedbackSurfaceView;
  pageUrl: string;
  pagePath: string;
  pageTitle: string;
  kind: FeedbackMarkKind;
  body: string;
  anchor: FeedbackAnchor;
  status: FeedbackStatus;
  outcome: FeedbackOutcome | null;
  card: FeedbackCardRef | null;
  /** A processor AI was woken for it and has not acted yet. */
  working: boolean;
  commentCount: number;
  unread: boolean;
  hasScreenshot: boolean;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  closedAt: string | null;
}

export interface FeedbackThreadEntry {
  id: string;
  type: FeedbackEventType;
  actor: FeedbackPerson;
  /** The comment text; for a forward the reason, only for processors (else null). */
  body: string | null;
  card: FeedbackCardRef | null;
  createdAt: string;
}

export interface FeedbackMarkDetail extends FeedbackMarkView {
  thread: FeedbackThreadEntry[];
  /** Processors only. */
  environment: FeedbackEnvironment | null;
  /** Processors only. */
  screenshot: FeedbackScreenshotMeta | null;
  canProcess: boolean;
  canComment: boolean;
}

export interface FeedbackMarker {
  handle: MemberHandle;
  name: string;
  color: number;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'not an http(s) URL');

export const CreateFeedbackMarkRequest = z.strictObject({
  pageUrl: httpUrl,
  pageTitle: z.string().trim().max(300),
  kind: FeedbackMarkKind,
  body: text(4000),
  anchor: FeedbackAnchor,
  environment: FeedbackEnvironment,
  screenshot: FeedbackScreenshotUpload.nullable(),
});
export type CreateFeedbackMarkRequest = z.infer<typeof CreateFeedbackMarkRequest>;

export const FeedbackCommentRequest = z.strictObject({ body: text(4000) });
export type FeedbackCommentRequest = z.infer<typeof FeedbackCommentRequest>;

export const CreateTaskFromFeedbackRequest = z.strictObject({
  title: text(200),
  description: z.string().trim().max(20000),
  reply: text(4000).optional(),
});
export type CreateTaskFromFeedbackRequest = z.infer<typeof CreateTaskFromFeedbackRequest>;

export const LinkFeedbackRequest = z.strictObject({ taskKey: TaskKey, reply: text(4000).optional() });
export type LinkFeedbackRequest = z.infer<typeof LinkFeedbackRequest>;

export const CloseFeedbackRequest = z.strictObject({ reply: text(4000).optional() });
export type CloseFeedbackRequest = z.infer<typeof CloseFeedbackRequest>;

export const FeedbackLaunchRequest = z.strictObject({
  surfaceId: FeedbackSurfaceId,
  markId: FeedbackMarkId.optional(),
});
export type FeedbackLaunchRequest = z.infer<typeof FeedbackLaunchRequest>;
export interface FeedbackLaunchResponse {
  url: string;
  expiresAt: string;
}

/** The one-time launch code: 32 random bytes, base64url. */
export const FeedbackSessionRequest = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export type FeedbackSessionRequest = z.infer<typeof FeedbackSessionRequest>;
export interface FeedbackSessionResponse {
  token: string;
  expiresAt: string;
  me: FeedbackPerson;
  project: { key: string; name: string };
  surface: FeedbackSurfaceView;
  markId: string | null;
  appUrl: string;
}

export interface FeedbackWidgetListResponse {
  marks: FeedbackMarkView[];
  markers: FeedbackMarker[];
  cursor: string;
  me: FeedbackPerson;
}

export interface FeedbackInboxResponse {
  marks: FeedbackMarkView[];
  surfaces: FeedbackSurfaceView[];
  markers: FeedbackMarker[];
  canProcess: boolean;
  canMark: boolean;
}

export interface FeedbackSummary {
  configured: boolean;
  canMark: boolean;
  canProcess: boolean;
  todo: number;
  unreadReplies: number;
}

export interface FeedbackSettingsView {
  publicBaseUrl: string | null;
  surfaces: (FeedbackSurfaceView & { lastMarkAt: string | null })[];
  markers: {
    handle: MemberHandle;
    name: string;
    access: HumanAccess;
    color: number;
    blocked: boolean;
    activeSessions: number;
    lastMarkAt: string | null;
  }[];
}

export interface CreateTaskFromFeedbackResponse {
  mark: FeedbackMarkDetail;
  task: { key: TaskKey; title: string };
}

/** A page the product shows the tool on: its address is the surface's origin (decision of PM-506). */
export const FeedbackSurface = z.strictObject({
  id: FeedbackSurfaceId,
  name: z.string().trim().min(1).max(40),
  origin: z.string().refine((value) => feedbackOriginRefusal(value) === null, 'not a valid origin'),
});
export type FeedbackSurface = z.infer<typeof FeedbackSurface>;

export const MAX_FEEDBACK_SURFACES = 20;
/**
 * `project.feedback`: the surfaces the tool may run on, and the members who may not mark. An
 * unknown handle in `blockedMarkers` has no effect.
 */
export const FeedbackConfig = z.strictObject({
  surfaces: z.array(FeedbackSurface).max(MAX_FEEDBACK_SURFACES).default([]),
  blockedMarkers: z.array(MemberHandle).default([]),
});
export type FeedbackConfig = z.infer<typeof FeedbackConfig>;

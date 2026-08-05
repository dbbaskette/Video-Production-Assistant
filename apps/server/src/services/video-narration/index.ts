/**
 * Compatibility barrel. Video upload and analysis now belong exclusively to
 * VideoUnderstandingService; narration writing consumes its text-only brief.
 */
export {
  generateScriptFromVideoBrief,
  serializeVideoUnderstandingBrief,
} from '../script/video-grounded.js';
export type { VideoGroundedScriptInput } from '../script/video-grounded.js';

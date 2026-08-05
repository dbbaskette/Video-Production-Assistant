import { describe, expect, it } from 'vitest';
import {
  canTightenQualityReviewCategory,
  qualityReviewCategoryTab,
} from './quality-review.js';

describe('quality review category behavior', () => {
  it('routes exact narration length findings to narration with a tighten action', () => {
    expect(qualityReviewCategoryTab('narration_too_long')).toBe('Narration');
    expect(canTightenQualityReviewCategory('narration_too_long')).toBe(true);
  });

  it('does not offer tightening for other narration findings', () => {
    expect(qualityReviewCategoryTab('narration')).toBe('Narration');
    expect(canTightenQualityReviewCategory('narration')).toBe(false);
  });
});

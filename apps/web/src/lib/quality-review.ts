export function qualityReviewCategoryTab(category: string): string | null {
  switch (category) {
    case 'recording': return 'Recording';
    case 'script': return 'Script';
    case 'narration':
    case 'narration_too_long': return 'Narration';
    case 'pacing': return 'Script';
    case 'lower_thirds': return 'Lower Thirds';
    default: return null;
  }
}

export function canTightenQualityReviewCategory(category: string): boolean {
  return category === 'narration_too_long';
}

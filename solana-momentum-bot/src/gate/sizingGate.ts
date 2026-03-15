import { BreakoutGrade } from '../utils/types';

export function getGradeSizeMultiplier(grade?: BreakoutGrade): number {
  return grade === 'B' ? 0.5 : 1.0;
}

export interface BootstrapCi {
  mean: number;
  lower: number;
  upper: number;
}

export interface BootstrapOptions {
  nResamples?: number;
  alpha?: number;
  random?: () => number;
}

export interface PermutationTestOptions {
  nPermutations?: number;
  alternative?: 'greater' | 'less' | 'two-sided';
  random?: () => number;
}

export function bootstrapMeanCI(
  data: number[],
  options: BootstrapOptions = {}
): BootstrapCi {
  if (data.length === 0) {
    return { mean: 0, lower: 0, upper: 0 };
  }

  const nResamples = Math.max(1, Math.floor(options.nResamples ?? 10_000));
  const alpha = clampAlpha(options.alpha ?? 0.05);
  const random = options.random ?? Math.random;
  const n = data.length;
  const mean = average(data);

  if (data.every((value) => value === data[0])) {
    return { mean, lower: data[0], upper: data[0] };
  }

  const means: number[] = [];
  for (let i = 0; i < nResamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += data[Math.floor(random() * n)];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);

  const lowerIndex = Math.max(0, Math.floor((alpha / 2) * nResamples));
  const upperIndex = Math.min(nResamples - 1, Math.ceil((1 - alpha / 2) * nResamples) - 1);

  return {
    mean,
    lower: means[lowerIndex],
    upper: means[upperIndex],
  };
}

export function permutationTestPValue(
  sampleA: number[],
  sampleB: number[],
  options: PermutationTestOptions = {}
): number {
  if (sampleA.length === 0 || sampleB.length === 0) {
    return 1;
  }

  const nPermutations = Math.max(1, Math.floor(options.nPermutations ?? 10_000));
  const alternative = options.alternative ?? 'two-sided';
  const random = options.random ?? Math.random;
  const observedDiff = average(sampleA) - average(sampleB);

  if (observedDiff === 0 && sampleA.length === sampleB.length && arraysEqual(sampleA, sampleB)) {
    return 1;
  }

  const pooled = [...sampleA, ...sampleB];
  const nA = sampleA.length;
  const total = pooled.length;
  let extremeCount = 0;

  for (let i = 0; i < nPermutations; i++) {
    const shuffled = [...pooled];
    for (let j = 0; j < nA; j++) {
      const k = j + Math.floor(random() * (total - j));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }

    const permDiff = average(shuffled.slice(0, nA)) - average(shuffled.slice(nA));
    if (isPermutationExtreme(permDiff, observedDiff, alternative)) {
      extremeCount++;
    }
  }

  return extremeCount / nPermutations;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0) return 0.05;
  if (alpha >= 1) return 0.999;
  return alpha;
}

function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isPermutationExtreme(
  permDiff: number,
  observedDiff: number,
  alternative: 'greater' | 'less' | 'two-sided'
): boolean {
  if (alternative === 'greater') {
    return permDiff >= observedDiff;
  }
  if (alternative === 'less') {
    return permDiff <= observedDiff;
  }
  return Math.abs(permDiff) >= Math.abs(observedDiff);
}

// @ts-nocheck
/** In-place radix-2 FFT. Both arrays must have the same power-of-two length. */
export function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n < 2 || (n & (n - 1)) !== 0 || imag.length !== n) throw new Error('Invalid FFT size');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = (-2 * Math.PI) / size;
    const stepR = Math.cos(angle),
      stepI = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wr = 1,
        wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const a = start + j,
          b = a + size / 2;
        const tr = wr * real[b] - wi * imag[b],
          ti = wr * imag[b] + wi * real[b];
        real[b] = real[a] - tr;
        imag[b] = imag[a] - ti;
        real[a] += tr;
        imag[a] += ti;
        const nextR = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR;
        wr = nextR;
      }
    }
  }
}

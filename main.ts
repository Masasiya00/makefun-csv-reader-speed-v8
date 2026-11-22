// Driver entry csv-reader-speed: baca semua kasus, jawab tiap kasus dengan
// run() dari solve.js, tulis jawabannya sebagai JSON array.
// Jalur input/output diambil dari env var (dipakai grade-local --driver
// process saat men-stage scratch dir), fallback ke mount absolut container.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

// Matikan incremental marking dan optimizing compiler SEBELUM solve.js
// diimpor: keduanya terukur lebih cepat untuk satu cold run, dan jawaban
// tidak berubah. Flag yang tak dikenal di Node grader tidak boleh
// menggagalkan run: setFlagsFromString di Node saat ini hanya mencetak
// peringatan ke stderr untuk flag tak dikenal, tapi try/catch menjaga
// kalau perilaku itu berubah di build lain.
for (const flag of ['--no-incremental-marking', '--no-opt']) {
  try {
    setFlagsFromString(flag);
  } catch {
    // Flag tidak didukung di runtime ini; lanjut tanpa flag itu.
  }
}

const { run } = await import('./solve.js');

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const answers = [];
for (const entry of cases) {
  answers.push(run(entry.input));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));

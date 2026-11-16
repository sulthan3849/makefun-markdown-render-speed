// Driver for the markdown-render-speed entry.
// Reads every case from the input directory, renders each one on its own with
// parse() from parse.js, and writes the HTML strings (in the cases' order) to
// the output directory as a JSON array. Run as `node main.ts` (Node 22).
// Outside a container, MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for
// /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];
if (!Array.isArray(cases)) throw new Error('cases.json must contain a JSON array');
const outPath = join(outputDir, 'html.json');

// Render each case on its own, in order; parse() is stateless per call, so
// the output is deterministic and independent of the other cases.
const rendered = cases.map((c) => parse(c.markdown));

writeFileSync(outPath, JSON.stringify(rendered));

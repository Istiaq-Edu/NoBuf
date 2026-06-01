// Restore mux.js extendFirstKeyFrame to original behavior.
//
// The true passthrough patch (return gops) preserved all P-frames but
// allowed segments starting with P-frames (mid-GOP flushes). Chrome's MSE
// decoder requires each append to start with a keyframe (sync sample) in
// "segments" mode. P-frames at segment start cause decoder artifacts
// (blurry, wrong colors) and stuttering because Chrome can't properly
// initialize the decode context for non-sync samples at append boundaries.
//
// The original extendFirstKeyFrame removes incomplete first GOPs (ensuring
// keyframe alignment) and extends the keyframe's duration to cover the
// removed time range. This produces keyframe-aligned segments that Chrome
// can decode correctly (no quality deformation).
//
// Trade-off: P-frames from incomplete first GOPs are dropped (~0.07-0.33s
// per flush, ~1-5% of data). This causes minor stuttering but no visual
// artifacts. The dropped amount is reduced by using larger flush intervals
// (8 chunks = 2MB per flush, producing ~1s segments with multiple GOPs).
//
// GOP cache is cleared after each flush to prevent GOP fusion, which only
// applies to video (not audio) and creates audio/video timing misalignment
// in the combined SourceBuffer.

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const PATCHED_MARKER = 'PATCHED: Restored original extendFirstKeyFrame';

// We restore the original code by removing any existing patches.
// The patch script will detect existing patches and replace them
// with the original (unpatched) code.

// No new code to apply — we're RESTORING the original extendFirstKeyFrame.
// The script below detects existing patches and removes them, restoring
// the original mux.js code.

const filesToRestore = [
  join(process.cwd(), 'node_modules/mux.js/es/mp4/frame-utils.js'),
  join(process.cwd(), 'node_modules/mux.js/lib/mp4/frame-utils.js'),
  join(process.cwd(), 'node_modules/mux.js/cjs/mp4/frame-utils.js'),
  join(process.cwd(), 'node_modules/mux.js/dist/mux.js'),
  join(process.cwd(), 'node_modules/mux.js/dist/mux-mp4.js'),
];

// Original extendFirstKeyFrame code (ES/cjs format — named function)
const originalCodeEs = [
  'var extendFirstKeyFrame = function extendFirstKeyFrame(gops) {',
  '  var currentGop;',
  '',
  '  if (!gops[0][0].keyFrame && gops.length > 1) {',
  '    // Remove the first GOP',
  '    currentGop = gops.shift();',
  '    gops.byteLength -= currentGop.byteLength;',
  '    gops.nalCount -= currentGop.nalCount; // Extend the first frame of what is now the',
  '    // first gop to cover the time period of the',
  '    // frames we just removed',
  '',
  '    gops[0][0].dts = currentGop.dts;',
  '    gops[0][0].pts = currentGop.pts;',
  '    gops[0][0].duration += currentGop.duration;',
  '  }',
  '',
  '  return gops;',
  '};',
].join('\n');

// Original extendFirstKeyFrame code (lib format — unnamed function)
const originalCodeLib = [
  'var extendFirstKeyFrame = function(gops) {',
  '  var currentGop;',
  '',
  '  if (!gops[0][0].keyFrame && gops.length > 1) {',
  '    // Remove the first GOP',
  '    currentGop = gops.shift();',
  '',
  '    gops.byteLength -= currentGop.byteLength;',
  '    gops.nalCount -= currentGop.nalCount;',
  '',
  '    // Extend the first frame of what is now the',
  '    // first gop to cover the time period of the',
  '    // frames we just removed',
  '    gops[0][0].dts = currentGop.dts;',
  '    gops[0][0].pts = currentGop.pts;',
  '    gops[0][0].duration += currentGop.duration;',
  '  }',
  '',
  '  return gops;',
  '};',
].join('\n');

// Original extendFirstKeyFrame code (dist format — indented)
const originalCodeDist = [
  '  var extendFirstKeyFrame = function extendFirstKeyFrame(gops) {',
  '    var currentGop;',
  '',
  '    if (!gops[0][0].keyFrame && gops.length > 1) {',
  '      // Remove the first GOP',
  '      currentGop = gops.shift();',
  '      gops.byteLength -= currentGop.byteLength;',
  '      gops.nalCount -= currentGop.nalCount;',
  '      // Extend the first frame of what is now the',
  '      // first gop to cover the time period of the',
  '      // frames we just removed',
  '',
  '      gops[0][0].dts = currentGop.dts;',
  '      gops[0][0].pts = currentGop.pts;',
  '      gops[0][0].duration += currentGop.duration;',
  '    }',
  '',
  '    return gops;',
  '  };',
].join('\n');

for (const filePath of filesToRestore) {
  try {
    let content = readFileSync(filePath, 'utf8');

    // Check if already restored (contains original code, no patch marker)
    if (!content.includes('PATCHED') && !content.includes('return gops;')) {
      console.log(`Already original (no patch found): ${filePath}`);
      continue;
    }

    // If it contains the true passthrough patch, replace it with original code
    // Handle different file formats

    // Normalize path separators for cross-platform matching
    const normPath = filePath.replace(/\\/g, '/');

    if (normPath.includes('dist/')) {
      // Dist files: replace patched function with original (indented) code
      const patchedRegex = /var extendFirstKeyFrame = function extendFirstKeyFrame\(gops\)\s*\{[\s\S]*?return gops;\s*\};/;
      const match = content.match(patchedRegex);
      if (match) {
        content = content.replace(match[0], originalCodeDist);
        writeFileSync(filePath, content, 'utf8');
        console.log(`Restored original extendFirstKeyFrame (dist): ${filePath}`);
      } else {
        console.log(`No patch target found in dist: ${filePath}`);
      }
    } else if (normPath.includes('lib/mp4/frame-utils.js')) {
      // lib format: unnamed function
      const patchedRegex = /var extendFirstKeyFrame = function\(gops\)\s*\{[\s\S]*?return gops;\s*\};/;
      const match = content.match(patchedRegex);
      if (match) {
        content = content.replace(match[0], originalCodeLib);
        writeFileSync(filePath, content, 'utf8');
        console.log(`Restored original extendFirstKeyFrame (lib): ${filePath}`);
      } else {
        console.log(`No patch target found: ${filePath}`);
      }
    } else {
      // es/cjs format: named function
      const patchedRegex = /var extendFirstKeyFrame = function extendFirstKeyFrame\(gops\)\s*\{[\s\S]*?return gops;\s*\};/;
      const match = content.match(patchedRegex);
      if (match) {
        content = content.replace(match[0], originalCodeEs);
        writeFileSync(filePath, content, 'utf8');
        console.log(`Restored original extendFirstKeyFrame: ${filePath}`);
      } else {
        console.log(`No patch target found: ${filePath}`);
      }
    }
  } catch (e) {
    console.log(`File not found or error: ${filePath} - ${e.message}`);
  }
}

console.log('\nPatch restoration complete. Original extendFirstKeyFrame ensures keyframe-aligned segments.');
console.log('Trade-off: ~0.07-0.33s P-frames dropped per flush (minor stuttering, no quality deformation).');
console.log('Mitigated by FLUSH_INTERVAL=8 (2MB per flush, fewer mid-GOP flushes).');

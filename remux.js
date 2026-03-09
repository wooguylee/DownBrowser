#!/usr/bin/env node

const path = require('node:path');
const { runFfmpegRemux } = require('./lib/remux-helper');

function printHelp() {
  console.log(`Usage:
  node remux.js --input <file.ts> [options]

Options:
  --input <path>     Input media file
  --output <path>    Output file path
  --format <ext>     Output extension when --output is omitted. Default: mp4
  --overwrite        Pass -y to ffmpeg
  --ffmpeg <path>    Custom ffmpeg executable path. Default: ffmpeg
  --help             Show this help

Examples:
  node remux.js --input downloads/my-video.ts
  node remux.js --input downloads/my-video.ts --format mkv
  node remux.js --input downloads/my-video.ts --output downloads/my-video.mp4 --overwrite
`);
}

function parseArgs(argv) {
  const options = {
    format: 'mp4',
    overwrite: false,
    ffmpeg: 'ffmpeg',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      options.help = true;
    } else if (arg === '--input') {
      options.input = argv[++i];
    } else if (arg === '--output') {
      options.output = argv[++i];
    } else if (arg === '--format') {
      options.format = argv[++i].replace(/^\./, '');
    } else if (arg === '--overwrite') {
      options.overwrite = true;
    } else if (arg === '--ffmpeg') {
      options.ffmpeg = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function runFfmpeg(options) {
  const outputPath = await runFfmpegRemux({
    input: options.input,
    output: options.output,
    format: options.format,
    overwrite: options.overwrite,
    ffmpeg: options.ffmpeg,
    stdio: 'inherit',
  });

  console.log(`Remuxed file: ${outputPath}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input) {
    printHelp();
    return;
  }

  await runFfmpeg(options);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

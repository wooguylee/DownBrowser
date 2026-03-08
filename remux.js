#!/usr/bin/env node

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

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

function buildOutputPath(inputPath, explicitOutput, format) {
  if (explicitOutput) {
    return explicitOutput;
  }
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.${format}`);
}

async function runFfmpeg(options) {
  const inputPath = path.resolve(process.cwd(), options.input);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const outputPath = path.resolve(process.cwd(), buildOutputPath(inputPath, options.output, options.format));
  const args = [];

  if (options.overwrite) {
    args.push('-y');
  }

  args.push('-i', inputPath, '-c', 'copy', outputPath);

  await new Promise((resolve, reject) => {
    const child = spawn(options.ffmpeg, args, {
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}`));
    });
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

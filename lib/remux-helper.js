const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function buildOutputPath(inputPath, explicitOutput, format) {
  if (explicitOutput) {
    return explicitOutput;
  }
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.${format}`);
}

async function runFfmpegRemux(options) {
  const inputPath = path.resolve(process.cwd(), options.input);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const outputPath = path.resolve(process.cwd(), buildOutputPath(inputPath, options.output, options.format || 'mp4'));
  const args = [];
  if (options.overwrite) {
    args.push('-y');
  }
  args.push('-i', inputPath, '-c', 'copy', outputPath);

  await new Promise((resolve, reject) => {
    const child = spawn(options.ffmpeg || 'ffmpeg', args, {
      stdio: options.stdio || 'inherit',
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk) => options.onLog?.(chunk.toString()));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => options.onLog?.(chunk.toString()));
    }

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

  return outputPath;
}

module.exports = {
  buildOutputPath,
  runFfmpegRemux,
};

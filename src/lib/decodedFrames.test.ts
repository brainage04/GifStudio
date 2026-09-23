import { describe, expect, it } from 'vitest';
import { frameSequenceInput } from './decodedFrames';

describe('frameSequenceInput', () => {
  it('keeps every frame delay at centisecond resolution and moves the last one to the GIF muxer', () => {
    const input = frameSequenceInput([
      { name: 'frame-0.png', durationMs: 100 },
      { name: 'frame-1.png', durationMs: 504 },
      { name: 'frame-2.png', durationMs: 250 },
    ]);

    expect(input.script).toBe(
      [
        'ffconcat version 1.0',
        "file 'frame-0.png'",
        'option framerate 100',
        'duration 0.10',
        "file 'frame-1.png'",
        'option framerate 100',
        'duration 0.50',
        "file 'frame-2.png'",
        'option framerate 100',
        'duration 0.25',
        '',
      ].join('\n'),
    );
    expect(input.inputArgs).toEqual(['-f', 'concat', '-safe', '0']);
    expect(input.outputArgs).toEqual(['-final_delay', '25']);
  });

  it('never rounds a delay down to zero', () => {
    const input = frameSequenceInput([{ name: 'frame-0.png', durationMs: 4 }]);

    expect(input.script).toContain('duration 0.01');
    expect(input.outputArgs).toEqual(['-final_delay', '1']);
  });
});

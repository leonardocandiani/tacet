import { describe, expect, test } from 'bun:test';
import { makeSink, makeVoice } from './wire';
import { ConfigError } from './config';

// Configuration mistakes are made once, in a hurry, before a meeting. What
// matters is that the message names the entry and says what to write instead.

describe('urls that came out of a config file', () => {
  test('a webhook without a scheme is refused with a hint', () => {
    expect(() => makeSink({ use: 'webhook', url: 'hooks.example.com/x' })).toThrow(ConfigError);
    expect(() => makeSink({ use: 'webhook', url: 'hooks.example.com/x' })).toThrow(/absolute url/);
  });

  test('a url that parses but is not http is refused too', () => {
    // "localhost:9000/hook" parses cleanly as a URL whose protocol is
    // "localhost:", which is the version of this mistake that used to survive
    // all the way to a silent delivery failure.
    expect(() => makeSink({ use: 'webhook', url: 'localhost:9000/hook' })).toThrow(/http or https/);
  });

  test('a real url builds a sink named after its host', () => {
    expect(makeSink({ use: 'webhook', url: 'https://hooks.example.com/x' }).name).toBe('webhook:hooks.example.com');
  });

  test('the same rule applies to an http voice', () => {
    expect(() => makeVoice({ use: 'http', baseUrl: 'localhost:8080/tts' })).toThrow(ConfigError);
    expect(makeVoice({ use: 'http', baseUrl: 'http://localhost:8080/tts' }).name).toContain('localhost');
  });
});

describe('an adapter name that does not exist', () => {
  test('says what was expected instead', () => {
    expect(() => makeVoice({ use: 'espeak' })).toThrow(/espeak/);
    expect(() => makeSink({ use: 'ftp' as never })).toThrow(/ftp/);
  });
});

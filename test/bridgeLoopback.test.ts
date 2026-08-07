// BR-1: the bridge connects to loopback or it fails.
//
// The negative controls are the point of this file. A single "reject a public
// IP" case would pass for a guard with any of six other holes, so each way of
// making a target LOOK like loopback gets its own case, and the two forms
// that are genuinely 127.0.0.1 in disguise are pinned as ACCEPTED so the
// guard cannot be tightened into something that rejects the real thing.

import { describe, expect, it } from 'vitest';
import { ALLOWED_LOOPBACK_HOSTS, assertLoopbackTarget } from '../src/bridge/loopback.js';

describe('assertLoopbackTarget', () => {
  it('accepts the two loopback addresses', () => {
    expect(assertLoopbackTarget('http://127.0.0.1:3335/mcp-0123456789abcdef').host).toBe('127.0.0.1:3335');
    expect(assertLoopbackTarget('http://[::1]:3335/mcp-0123456789abcdef').hostname).toBe('[::1]');
    expect(ALLOWED_LOOPBACK_HOSTS).toEqual(['127.0.0.1', '::1']);
  });

  it('accepts alternative spellings the URL parser normalizes TO 127.0.0.1', () => {
    // Not laxity: after normalization these are the allowed value itself.
    // Pinned so the guard is not "fixed" into rejecting them, which would be
    // a claim about the string rather than about the destination.
    expect(assertLoopbackTarget('http://2130706433/mcp-x').hostname).toBe('127.0.0.1');
    expect(assertLoopbackTarget('http://0177.0.0.1/mcp-x').hostname).toBe('127.0.0.1');
  });

  // The seven ways a target can be non-loopback while looking loopback-ish.
  const rejected: Array<[string, string]> = [
    ['a public address', 'http://93.184.216.34/mcp-x'],
    ['a hostname, including localhost', 'http://localhost:3335/mcp-x'],
    ['another hostname', 'http://evil.example/mcp-x'],
    ['a hostname that merely starts with the address', 'http://127.0.0.1.evil.example/mcp-x'],
    ['an IPv4-mapped IPv6 address', 'http://[::ffff:127.0.0.1]:3335/mcp-x'],
    ['userinfo forgery', 'http://127.0.0.1@evil.example/mcp-x'],
    ['userinfo forgery with a port-looking password', 'http://127.0.0.1:3335@evil.example/mcp-x'],
    ['another address inside 127/8', 'http://127.0.0.2:3335/mcp-x'],
    ['the top of 127/8', 'http://127.255.255.254:3335/mcp-x'],
    ['a non-http scheme', 'https://127.0.0.1:3335/mcp-x'],
    ['a file URL', 'file:///etc/passwd'],
    ['not a URL at all', '127.0.0.1:3335/mcp-x'],
  ];
  for (const [label, target] of rejected) {
    it(`refuses ${label}`, () => {
      expect(() => assertLoopbackTarget(target)).toThrow(/refusing/);
    });
  }

  it('refuses credentials even on a loopback host', () => {
    // The server has no authentication; a credential in the target is either
    // a mistake or an attempt to smuggle one somewhere.
    expect(() => assertLoopbackTarget('http://user:pw@127.0.0.1:3335/mcp-x')).toThrow(/credentials/);
  });
});

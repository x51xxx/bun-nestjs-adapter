import { VERSION_NEUTRAL, VersioningOptions, VersioningType } from '@nestjs/common';
// Nest 12 added an `exports` map to @nestjs/common where `./*` resolves to
// `./*.js`, so the bare `@nestjs/common/interfaces` directory import no
// longer resolves (only `interfaces/index.js` exists on disk). The concrete
// file resolves on 10, 11 and 12 alike, and `VersionValue` is not on the
// package root — it moved to `@nestjs/common/internal`, which 10/11 lack.
import { VersionValue } from '@nestjs/common/interfaces/version-options.interface';
import { BunRequest, BunResponse, BunRouteHandler } from './types';

type NextFn = (err?: unknown) => void;

function matchesVersion(version: VersionValue, extracted: string): boolean {
  if (Array.isArray(version)) return version.includes(extracted);
  return typeof version === 'string' && version === extracted;
}

function neutralAllowed(version: VersionValue): boolean {
  return Array.isArray(version) && version.includes(VERSION_NEUTRAL);
}

/**
 * Pull the version out of an `Accept` header for MEDIA_TYPE versioning — a
 * port of upstream's `getMediaTypeVersion` (express/fastify). Every media range
 * and every `;` parameter is scanned, so `application/json;q=0.9;v=2` and
 * `text/html, application/json;v=2` both yield `2`, where taking only the
 * first parameter of the whole header missed them.
 */
export function getMediaTypeVersion(
  acceptHeader: string | string[] | undefined,
  key: string,
): string | undefined {
  const values = acceptHeader === undefined ? [] : ([] as string[]).concat(acceptHeader);
  for (const value of values) {
    for (const mediaRange of value.split(',')) {
      const parameters = mediaRange.split(';');
      for (let i = 1; i < parameters.length; i++) {
        const parameter = parameters[i].trim();
        if (parameter.startsWith(key)) return parameter.slice(key.length);
      }
    }
  }
  return undefined;
}

/**
 * Wrap a route handler so it only fires when the request carries a matching
 * version (HEADER / MEDIA_TYPE / CUSTOM extractors); otherwise `next()` moves
 * on to the next version candidate registered for the same path.
 */
export function applyVersionFilter(
  rawHandler: Function,
  version: VersionValue,
  versioningOptions: VersioningOptions,
): BunRouteHandler {
  const handler = rawHandler as BunRouteHandler;
  const callNextHandler = (_req: BunRequest, _res: BunResponse, next?: NextFn) => {
    if (!next) {
      throw new Error('HTTP adapter does not support filtering on version');
    }
    return next();
  };

  if (version === VERSION_NEUTRAL || versioningOptions.type === VersioningType.URI) {
    return (req, res, next) => handler(req, res, next);
  }

  if (versioningOptions.type === VersioningType.CUSTOM) {
    const { extractor } = versioningOptions;
    return (req, res, next) => {
      const extracted = extractor(req);
      if (Array.isArray(extracted)) {
        if (Array.isArray(version)) {
          if (version.some(v => extracted.includes(v as string))) {
            return handler(req, res, next);
          }
        } else if (typeof version === 'string' && extracted.includes(version)) {
          return handler(req, res, next);
        }
      } else if (typeof extracted === 'string' && matchesVersion(version, extracted)) {
        return handler(req, res, next);
      }
      return callNextHandler(req, res, next);
    };
  }

  if (versioningOptions.type === VersioningType.MEDIA_TYPE) {
    const { key } = versioningOptions;
    return (req, res, next) => {
      const headerVersion = getMediaTypeVersion(req.headers['accept'], key);
      if (headerVersion === undefined) {
        if (neutralAllowed(version)) {
          return handler(req, res, next);
        }
      } else {
        if (matchesVersion(version, headerVersion)) {
          return handler(req, res, next);
        }
      }
      return callNextHandler(req, res, next);
    };
  }

  if (versioningOptions.type === VersioningType.HEADER) {
    const headerName = versioningOptions.header.toLowerCase();
    return (req, res, next) => {
      const headerVersion = req.headers[headerName];
      if (headerVersion === undefined || headerVersion === '') {
        if (neutralAllowed(version)) {
          return handler(req, res, next);
        }
      } else if (matchesVersion(version, headerVersion)) {
        return handler(req, res, next);
      }
      return callNextHandler(req, res, next);
    };
  }

  throw new Error('Unsupported versioning options');
}

import { VERSION_NEUTRAL, VersioningOptions, VersioningType } from '@nestjs/common';
import { VersionValue } from '@nestjs/common/interfaces';
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
      const accept = req.headers['accept'];
      const versionParam = accept ? accept.split(';')[1] : undefined;
      if (versionParam === undefined) {
        if (neutralAllowed(version)) {
          return handler(req, res, next);
        }
      } else {
        const headerVersion = versionParam.split(key)[1];
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

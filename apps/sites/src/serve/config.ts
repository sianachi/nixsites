import { optional, parseAddress, required } from '../worker/config.ts';

/**
 * What the serving process reads from its environment, checked once at startup.
 *
 * It holds no database credential and no Core secret: only a read credential for the sites
 * bucket (production: a read-only key scoped to that bucket) and the suffix it may answer for.
 */

export interface ServeConfig {
  readonly address: { readonly host: string; readonly port: number };
  readonly s3: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKey: string;
    readonly secretKey: string;
  };
  /** Lowercase, no leading dot. Its subdomains are looked up, its apex is refused; other hosts need a host manifest. */
  readonly allowedSuffix: string;
  /**
   * Set on an instance sharing the sites domain one label deep (for example `-home`): only hosts
   * `<label><suffix>.<allowedSuffix>` count as its own default hostnames. Empty when unset.
   */
  readonly defaultLabelSuffix: string;
}

export function readServeConfig(env: NodeJS.ProcessEnv): ServeConfig {
  const suffix = required(env, 'NIX_SITES_ALLOWED_SUFFIX')
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(suffix)) {
    throw new Error('NIX_SITES_ALLOWED_SUFFIX must be a domain name such as sites.example.com.');
  }
  const labelSuffix = optional(env, 'NIX_SITES_DEFAULT_LABEL_SUFFIX', '');
  if (
    labelSuffix !== '' &&
    (labelSuffix.length > 21 || !/^-[a-z0-9](-?[a-z0-9]){1,19}$/.test(labelSuffix))
  ) {
    throw new Error(
      'NIX_SITES_DEFAULT_LABEL_SUFFIX must be a hyphen and a short lowercase label such as -home.',
    );
  }
  const endpoint = required(env, 'NIX_SITES_S3_ENDPOINT');
  try {
    new URL(endpoint);
  } catch {
    throw new Error('NIX_SITES_S3_ENDPOINT must be an absolute URL.');
  }
  return {
    address: parseAddress(env.NIX_SITES_SERVE_ADDRESS ?? ':8400'),
    s3: {
      endpoint: endpoint.replace(/\/+$/, ''),
      region: optional(env, 'NIX_SITES_S3_REGION', 'us-east-1'),
      bucket: required(env, 'NIX_SITES_S3_BUCKET'),
      accessKey: required(env, 'NIX_SITES_S3_ACCESS_KEY'),
      secretKey: required(env, 'NIX_SITES_S3_SECRET_KEY'),
    },
    allowedSuffix: suffix,
    defaultLabelSuffix: labelSuffix,
  };
}

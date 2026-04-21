/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['@node-rs/argon2', '@prisma/client'],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(config.externals || []),
        '@node-rs/argon2',
        ({ request }, cb) => {
          if (typeof request === 'string' && request.startsWith('@node-rs/argon2')) {
            return cb(null, `commonjs ${request}`);
          }
          cb();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;

"use strict";
const { withAndroidManifest } = require("expo/config-plugins");

/**
 * Atlas accepts HTTP only for loopback and private-network servers. Android
 * cannot express a dynamic user-selected private IP range in a network
 * security config, so the manifest must permit cleartext while the URL parser
 * remains the enforcement point for which backend URLs are accepted.
 */
module.exports = function withLocalCleartext(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("Android manifest is missing its application element.");
    }

    application.$ ??= {};
    application.$["android:usesCleartextTraffic"] = "true";
    return nextConfig;
  });
};

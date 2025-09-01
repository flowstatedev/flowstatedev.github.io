// const path = require("path");
const HtmlBundlerPlugin = require('html-bundler-webpack-plugin');
module.exports = {
  plugins: [
    new HtmlBundlerPlugin({
      minify: true,
      entry: [
        {
          import: "./src/index.html",
          filename: 'index.html',
        }
      ],
      preprocessor: 'ejs',
      js: {
        filename: "[name].[contenthash:12].js",
      },
      css: {
        filename: "[name].[contenthash:12].css",
      },
    }),
  ],
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: [
          "css-loader",
        ],
      },
      {
        // in a *real* project, the right way to do this would
        // be to have a static/ folder
        test: /\/favicon\//i,
        type: 'asset/resource',
        generator: {
          filename: "[name].[contenthash:12][ext]"
        }
      }
    ],
  },
};

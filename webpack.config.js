//@ts-check
'use strict';

const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require("copy-webpack-plugin");  
//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  
  entry: {
    extension: './src/extension.ts',
    webviewPanel: './src/webviewPanel.ts'
  },
  
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2'
  },
  
  
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: "icons/*.png",
          to: path.join(__dirname, "dist", "icons", "[name][ext]"),
          noErrorOnMissing: true
        }
      ]
    })
  ],
  
  externals: {
    vscode: 'commonjs vscode',
    'http': 'commonjs http',
    'https': 'commonjs https',
    'stream': 'commonjs stream',
    'zlib': 'commonjs zlib'
  },
  
  resolve: {
    extensions: ['.ts', '.js'],
    fallback: {
      "http": false,
      "https": false,
      "stream": false,
      "zlib": false,
      "util": false,
      "url": false,
      "buffer": false
    }
  },
  
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      },
      {
        test: /node_modules\/axios\/.*\.js$/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      }
    ]
  },
  
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log",
  },
};

module.exports = [extensionConfig];
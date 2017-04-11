'use strict';

const gulp = require('gulp');
const gutil = require('gulp-util');

const argv = require('yargs').argv;
const cheerio = require('gulp-cheerio');
const child_process = require('child_process');
const cpExec = require('child_process').exec;
const del = require('del');
const fsExtra = require('fs-extra');
const fs = fsExtra;
const globby = require("globby");
// const os = require('os');
const path = require('canonical-path');
const Q = require("q");
const replace = require('gulp-replace');
const spawn = require('child_process').spawn;
const taskListing = require('gulp-task-listing');
// cross platform version of spawn that also works on windows.
const xSpawn = require('cross-spawn');

function xExec(cmd_and_args, options) {
  const cmd_and_args_arr = cmd_and_args.split(' ');
  const pp = spawnExt(cmd_and_args_arr[0], cmd_and_args_arr.splice(1), options);
  return pp;
}

const exec = xExec; // cpExec;
const npmbin = path.resolve('node_modules/.bin');
const npmbinMax = `node --max-old-space-size=4096 ${npmbin}`;

const THIS_PROJECT_PATH = path.resolve('.');
// angular.io constants
// TODO: get path from the env
const ANGULAR_PROJECT_PATH = '../angular2'; // WARNING: some old scripts expect this to be ../angular
const PUBLIC_PATH = './public';
const DOCS_PATH = path.join(PUBLIC_PATH, 'docs');
const EXAMPLES_PATH = './examples/ng/doc';
const TOOLS_PATH = './tools';
const TMP_PATH = process.env.TMP;

const angulario = path.resolve('../angular.io');
gutil.log(`Using angular.io repo at ${angulario}`)

const isSilent = !!argv.silent;
if (isSilent) gutil.log = gutil.noop;
const _dgeniLogLevel = argv.dgeniLog || (isSilent ? 'error' : 'warn');

const fragsPath = path.join('src', 'angular', '_fragments');
const qsProjName = 'angular_quickstart';
const config = {
  _dgeniLogLevel:_dgeniLogLevel,
  ANGULAR_PROJECT_PATH:ANGULAR_PROJECT_PATH, angulario: angulario,
  angularRepo: ANGULAR_PROJECT_PATH, // TODO: eliminate one of these alias
  DOCS_PATH: DOCS_PATH,
  EXAMPLES_PATH: EXAMPLES_PATH,
  qsProjName: qsProjName,
  relDartDocApiDir: path.join('doc', 'api'),
  THIS_PROJECT_PATH: THIS_PROJECT_PATH,
  TOOLS_PATH: TOOLS_PATH,
  frags: {
    apiDirName: '_api',
    dirName: path.basename(fragsPath),
    path: fragsPath,
  },
  webSimpleProjPath: path.join(TMP_PATH, qsProjName),
};

const plugins = {
  argv:argv, child_process:child_process, copyFiles:copyFiles, del:del, execp:execp, fs:fs, globby:globby,
  gutil:gutil, path:path, q:Q, replace:replace, spawnExt:spawnExt
};

const extraTasks = `
  api api-list cheatsheet dartdoc examples example-frag example-template
  ngio-get ngio-put sass test update-ng-vers update-web-simple`;
extraTasks.split(/\s+/).forEach(task => task && require(`./gulp/${task}`)(gulp, plugins, config))

if (!TMP_PATH) {
  const msg = 'TMP environment variable is undefined.\n' +
    'Did you forget to: source ./scripts/env-set.sh?';
  console.log(msg);
  throw msg;
}

//-----------------------------------------------------------------------------
// Tasks
//

// Task: build
// Options:
//   --fast  skips generation of dartdocs if they already exist
//
// Ideally, we'd want to ensure that update-web-simple completes before the other
// tasks but it is too much work to do that in gulp 3.x. Generally it shouldn't be
// a problem. We can always fix the dependencies once gulp 4.x is out.
gulp.task('build', ['update-web-simple', 'create-example-fragments', 'dartdoc',
    'build-api-list-json', 'build-cheatsheet', 'finalize-api-docs', 'sass'], cb => {
  // There is a rule in public/docs/_examples/.gitignore that prevents a2docs.css
  // from being excluded. Let's stay synced with the TS counterpart of that .gitignore
  // and just delete the file:
  child_process.execSync(`rm -f public/docs/_examples/_boilerplate/a2docs.css`);
  return execp(`jekyll build`);
});

gulp.task('build-deploy', ['build'], () => {
  // Note: .firebaserc will be used.
  return execp(`firebase deploy`);
});

gulp.task('site-refresh', ['_clean', 'get-ngio-files']);

const _cleanTargets = ['publish'];
const _delTmp = () => del(_cleanTargets, { force: true });
gulp.task('clean', cb => _delTmp());
gulp.task('_clean', cb => argv.clean ? _delTmp() : cb());
gulp.task('clean-src', cb => execp(`git clean -xdf src`));

gulp.task('default', ['help']);

gulp.task('help', taskListing.withFilters((taskName) => {
  var isSubTask = taskName.substr(0, 1) == "_";
  return isSubTask;
}, function (taskName) {
  var shouldRemove = taskName === 'default';
  return shouldRemove;
}));


//=============================================================================
// Helper functions
//

function execp(cmdAndArgs, options) {
  const cmd_and_args_arr = cmdAndArgs.split(' ');
  const pp = spawnExt(cmd_and_args_arr[0], cmd_and_args_arr.splice(1), options);
  return pp.promise;
}

// This version is used under angular.io for Windows folks ...
// returns both a promise and the spawned process so that it can be killed if needed.
function spawnExt(command, _args, options) {
  const args = _args || [];
  const deferred = Q.defer();
  const descr = command + " " + args.join(' ');
  let proc;
  gutil.log('async exec: ' + descr);
  try {
    proc = xSpawn.spawn(command, args, options);
  } catch (e) {
    gutil.log(e);
    deferred.reject(e);
    return { proc: null, promise: deferred.promise };
  }
  proc.stdout.on('data', data => gutil.log(data.toString()));
  proc.stderr.on('data', data => gutil.log(data.toString()));
  proc.on('close', function (returnCode) {
    gutil.log('completed: ' + descr);
    // Many tasks (e.g., tsc) complete but are actually errors;
    // Confirm return code is zero.
    returnCode === 0 ? deferred.resolve(0) : deferred.reject(returnCode);
  });
  proc.on('error', function (data) {
    gutil.log('completed with error:' + descr);
    gutil.log(data.toString());
    deferred.reject(data);
  });
  return { proc: proc, promise: deferred.promise };
}

// Copies fileNames into destPaths, setting the mode of the
// files at the destination as optional_destFileMode if given.
// returns a promise
function copyFiles(fileNames, destPaths, optional_destFileMode) {
  var copy = Q.denodeify(fsExtra.copy);
  var chmod = Q.denodeify(fsExtra.chmod);
  var copyPromises = [];
  destPaths.forEach(function(destPath) {
    fileNames.forEach(function(fileName) {
      var baseName = path.basename(fileName);
      var destName = path.join(destPath, baseName);
      var p = copy(fileName, destName, { clobber: true});
      if(optional_destFileMode !== undefined) {
        p = p.then(function () {
          return chmod(destName, optional_destFileMode);
        });
      }
      copyPromises.push(p);
    });
  });
  return Q.all(copyPromises);
}

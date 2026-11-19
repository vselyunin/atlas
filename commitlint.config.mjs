export default {
  extends: ['@commitlint/config-conventional'],
  defaultIgnores: false,
  rules: {
    'scope-empty': [2, 'never'],
    'scope-enum': [2, 'always', ['board', 'api', 'worker', 'contracts', 'repo']],
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'test', 'refactor', 'chore', 'build', 'ci', 'style', 'perf'],
    ],
  },
};

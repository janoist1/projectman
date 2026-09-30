import { describe, expect, it } from 'vitest';
import { parseShellCommand, SHELL_REDIRECTIONS } from '../src/domain/shell-words';

/** The words of the only stage of a single command. */
function words(command: string): string[] | null {
  const parsed = parseShellCommand(command);
  if (!parsed) return null;
  expect(parsed.segments).toHaveLength(1);
  expect(parsed.segments[0]!.stages).toHaveLength(1);
  return parsed.segments[0]!.stages[0]!.words;
}

describe('shell words: words and quotes', () => {
  it.each<[string, string[]]>([
    ['git status', ['git', 'status']],
    ['  git \t status  ', ['git', 'status']],
    ['ls -la apps/web/src', ['ls', '-la', 'apps/web/src']],
    ['grep -rn foo --include=*.ts', ['grep', '-rn', 'foo', '--include=*.ts']],
    ['git diff HEAD~1 HEAD^ main..feature/x', ['git', 'diff', 'HEAD~1', 'HEAD^', 'main..feature/x']],
    ['echo a#b a=b a:b a,b a+b a@b a%b', ['echo', 'a#b', 'a=b', 'a:b', 'a,b', 'a+b', 'a@b', 'a%b']],
    ['ls src/*.ts file?.md [a-c]x', ['ls', 'src/*.ts', 'file?.md', '[a-c]x']],
    ['cat café.md 日本語.txt', ['cat', 'café.md', '日本語.txt']],
    // Quotes.
    ["git commit -m 'Fix the bug'", ['git', 'commit', '-m', 'Fix the bug']],
    ['git commit -m "Fix the bug"', ['git', 'commit', '-m', 'Fix the bug']],
    ['echo "it\'s" \'say "hi"\'', ['echo', "it's", 'say "hi"']],
    ['echo a"b c"d\'e f\'g', ['echo', 'ab cde fg']],
    ["echo '' \"\" x''y", ['echo', '', '', 'xy']],
    // Single quotes are literal, whatever they hold.
    [
      "echo 'cost: $5 `ls` \\n $(rm -rf /) && ; | > < ( ) { } ~ # !'",
      ['echo', 'cost: $5 `ls` \\n $(rm -rf /) && ; | > < ( ) { } ~ # !'],
    ],
    // Double quotes hide operators and unquoted specials, and allow \" and \\.
    ['echo "a && b; c | d > e < f ( ) { } ~ # ! * ?"', ['echo', 'a && b; c | d > e < f ( ) { } ~ # ! * ?']],
    [String.raw`echo "say \"hi\" \\ done"`, ['echo', String.raw`say "hi" \ done`]],
    // Other backslashes stay literal in double quotes, and an escaped $ or backtick is plain text.
    [String.raw`echo "\$HOME"`, ['echo', '$HOME']],
    [String.raw`echo "\`ls\`"`, ['echo', '`ls`']],
    [String.raw`echo "a\nb"`, ['echo', String.raw`a\nb`]],
    [
      String.raw`grep -rnE "task\.(edit|save|move\.)" apps/web/src`,
      ['grep', '-rnE', String.raw`task\.(edit|save|move\.)`, 'apps/web/src'],
    ],
    ['echo "tab\there"', ['echo', 'tab\there']],
    ['echo "emoji 🙂 é — →"', ['echo', 'emoji 🙂 é — →']],
    // A tilde, hash or equals sign that cannot start an expansion or a comment is plain text.
    ["echo ''~ ''#x ''=y x~ x~y", ['echo', '~', '#x', '=y', 'x~', 'x~y']],
    ['echo ""~ ""#x ""=y', ['echo', '~', '#x', '=y']],
    ["echo a='b'~ 'c'~", ['echo', 'a=b~', 'c~']],
  ])('reads %j', (command, expected) => {
    expect(words(command)).toEqual(expected);
  });
});

describe('shell words: segments, pipes and redirections', () => {
  function shape(command: string) {
    const parsed = parseShellCommand(command);
    return (
      parsed && {
        segments: parsed.segments.map((segment) =>
          segment.stages.map((stage) => [stage.words.join(' '), ...stage.redirections].join(' ')),
        ),
        separators: parsed.separators,
      }
    );
  }

  it('splits segments at &&, || and ;, and stages at |', () => {
    expect(shape('a && b || c ; d')).toEqual({
      segments: [['a'], ['b'], ['c'], ['d']],
      separators: ['&&', '||', ';'],
    });
    expect(shape('a | b | c && d | e')).toEqual({
      segments: [
        ['a', 'b', 'c'],
        ['d', 'e'],
      ],
      separators: ['&&'],
    });
    expect(shape('a&&b||c;d|e')).toEqual({
      segments: [['a'], ['b'], ['c'], ['d', 'e']],
      separators: ['&&', '||', ';'],
    });
    expect(shape('a')).toEqual({ segments: [['a']], separators: [] });
  });

  it('does not split inside quotes', () => {
    expect(shape(`git commit -m "a && b; c | d" && echo 'x || y'`)).toEqual({
      segments: [['git commit -m a && b; c | d'], ['echo x || y']],
      separators: ['&&'],
    });
  });

  it.each(SHELL_REDIRECTIONS)('recognises %s as a redirection, not as a word', (redirection) => {
    const parsed = parseShellCommand(`ls -la ${redirection}`)!;
    expect(parsed.segments[0]!.stages[0]).toEqual({ words: ['ls', '-la'], redirections: [redirection] });
  });

  it('accepts redirections before a pipe, a separator or the end, in any order', () => {
    expect(shape('ls >/dev/null 2>&1 && echo ok')).toEqual({
      segments: [['ls >/dev/null 2>&1'], ['echo ok']],
      separators: ['&&'],
    });
    expect(shape('npm run typecheck 2>&1 | tail -5')).toEqual({
      segments: [['npm run typecheck 2>&1', 'tail -5']],
      separators: [],
    });
    expect(shape('ls 2>/dev/null;ls 1>/dev/null||true')).toEqual({
      segments: [['ls 2>/dev/null'], ['ls 1>/dev/null'], ['true']],
      separators: [';', '||'],
    });
    expect(shape('ls 2>&1&&echo ok')).toEqual({
      segments: [['ls 2>&1'], ['echo ok']],
      separators: ['&&'],
    });
    expect(shape('2>&1 ls')).toEqual({ segments: [['ls 2>&1']], separators: [] });
  });

  it('treats a quoted redirection as a plain word', () => {
    expect(words('echo \'2>&1\' ">/dev/null"')).toEqual(['echo', '2>&1', '>/dev/null']);
  });
});

describe('shell words: everything unsafe or unclear is refused', () => {
  it.each<[string, string]>([
    // Newlines and other control characters, even inside quotes.
    ['a newline', 'git status\nrm -rf /'],
    ['a newline inside quotes', "git commit -m 'one\ntwo'"],
    ['a carriage return', 'git status\r'],
    ['a NUL', 'git status\u0000'],
    ['an escape', 'echo \u001b[31m'],
    ['a vertical tab', 'echo a\u000bb'],
    ['a DEL', 'echo a\u007fb'],
    ['a C1 control', 'echo a\u0085b'],
    // Background jobs and other redirections.
    ['a single &', 'sleep 1 & echo x'],
    ['a trailing &', 'npm ci &'],
    ['&&&', 'a &&& b'],
    ['|&', 'a |& b'],
    ['&>', 'a &> log'],
    ['a redirect to a file', 'echo x > f'],
    ['a redirect without spaces', 'echo x>f'],
    ['an append', 'echo x >> f'],
    ['an input redirect', 'cat < f'],
    ['a here-string', 'cat <<< x'],
    ['a here-document', 'cat << EOF'],
    ['a process substitution', 'diff <(ls) <(ls)'],
    ['an output process substitution', 'tee >(cat)'],
    ['a duplicated descriptor', 'echo x >&2'],
    ['a redirect of another descriptor', 'echo x 3>/dev/null'],
    ['a redirect to a look-alike file', 'echo x >/dev/null2'],
    ['a redirect with a word glued to it', 'echo x 2>&1y'],
    ['a redirect followed by a quote', "echo x >/dev/null'y'"],
    ['a redirect glued to a word', 'echo x2>&1'],
    ['a redirect glued to a command', 'ls>/dev/null'],
    ['a redirect with a space', 'echo x > /dev/null'],
    ['a stage of redirections only', '>/dev/null'],
    // Expansions and grouping.
    ['a parameter', 'echo $HOME'],
    ['a braced parameter', 'echo ${HOME}'],
    ['a command substitution', 'echo $(ls)'],
    ['an arithmetic expansion', 'echo $((1+1))'],
    ['a backtick', 'echo `ls`'],
    ['an ANSI-C string', "echo $'a\\nb'"],
    ['a subshell', '(cd x && ls)'],
    ['a group', '{ ls; }'],
    ['a brace expansion', 'echo {a,b}'],
    ['a closing parenthesis', 'echo a)'],
    ['a closing brace', 'echo a}'],
    // Escapes, history, home directories, comments and assignments of commands.
    ['an unquoted backslash', 'echo a\\ b'],
    ['an escaped newline', 'echo a\\\nb'],
    ['an escaped semicolon', 'find . -exec ls {} \\;'],
    ['an exclamation mark', 'echo hi!'],
    ['a negation', '! ls'],
    ['a home directory', 'cat ~/.ssh/id_rsa'],
    ['a named home directory', 'ls ~root'],
    ['~ after =', 'ls --root=~/x'],
    ['~ after :', 'echo PATH=a:~/bin'],
    ['a zsh command expansion', 'cat =ls'],
    ['a comment', 'ls #; rm -rf /'],
    ['a comment at the start', '# ls'],
    // Quotes.
    ['an unbalanced single quote', "echo 'abc"],
    ['an unbalanced double quote', 'echo "abc'],
    ['a quote left open by an escape', 'echo "abc\\"'],
    ['a parameter in double quotes', 'echo "$HOME"'],
    ['a braced parameter in double quotes', 'echo "${HOME}"'],
    ['a substitution in double quotes', 'echo "$(ls)"'],
    ['a backtick in double quotes', 'echo "`ls`"'],
    ['a trailing backslash in double quotes', 'echo "a\\'],
    // Characters outside the safe set.
    ['a no-break space', 'echo a b'],
    ['a zero-width space', 'echo a​b'],
    ['an emoji outside quotes', 'echo 🙂'],
    ['a line separator', 'echo a b'],
    // Empty segments and stages.
    ['an empty command', ''],
    ['only blanks', ' \t '],
    ['a leading ;', '; ls'],
    ['a trailing ;', 'ls;'],
    ['a doubled ;', 'ls;; ls'],
    ['a leading &&', '&& ls'],
    ['a trailing &&', 'ls &&'],
    ['a doubled &&', 'ls && && ls'],
    ['a leading ||', '|| ls'],
    ['a trailing ||', 'ls ||'],
    ['a leading pipe', '| ls'],
    ['a trailing pipe', 'ls |'],
    ['a doubled pipe', 'ls | | ls'],
    ['|||', 'ls ||| ls'],
    ['an empty stage before a separator', 'ls | && ls'],
  ])('refuses %s', (_name, command) => {
    expect(parseShellCommand(command)).toBeNull();
  });

  it('refuses each refusal in every position of a longer command', () => {
    for (const fragment of ['$HOME', '`ls`', '$(ls)', '(ls)', '{a,b}', 'a\\ b', '~/x', '> f', '< f', '&']) {
      for (const command of [
        `${fragment} && git status`,
        `git status && ${fragment}`,
        `git status | ${fragment}`,
        `git commit -m x ${fragment}`,
      ]) {
        expect(parseShellCommand(command), command).toBeNull();
      }
    }
  });
});

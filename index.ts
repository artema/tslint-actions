import * as core from "@actions/core"; // tslint:disable-line
// Currently @actions/github cannot be loaded via import statement due to typing error
const github = require("@actions/github"); // tslint:disable-line
import { Context } from "@actions/github/lib/context";
import * as Octokit from "@octokit/rest";
import { stripIndent as markdown } from "common-tags";
import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";
import { Configuration, Linter, RuleSeverity } from "tslint";

const CHECK_NAME = "TSLint Checks";

const SeverityAnnotationLevelMap = new Map<RuleSeverity, "warning" | "failure">([
  ["warning", "warning"],
  ["error", "failure"],
]);

(async () => {
  const ctx = github.context as Context;

  const configFileName = core.getInput("config") || "tslint.json";
  const projectFileName = core.getInput("project");
  const pattern = core.getInput("pattern");
  const ghToken = core.getInput("token");

  if (!projectFileName && !pattern) {
    core.setFailed("tslint-actions: Please set project or pattern input");
    return;
  }

  if (!ghToken) {
    core.setFailed("tslint-actions: Please set token");
    return;
  }

  const octokit = new github.GitHub(ghToken) as Octokit;

  // Create check
  const check = await octokit.checks.create({
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    name: CHECK_NAME,
    head_sha: ctx.sha,
    status: "in_progress",
  });

  const options = {
    fix: false,
    formatter: "json",
  };

  // Create a new Linter instance
  const result = (() => {
    if (projectFileName && !pattern) {
      const projectDir = path.dirname(path.resolve(projectFileName));
      const program = Linter.createProgram(projectFileName, projectDir);
      const linter = new Linter(options, program);

      const files = Linter.getFileNames(program);
      for (const file of files) {
        const sourceFile = program.getSourceFile(file);
        if (sourceFile) {
          const fileContents = sourceFile.getFullText();
          const configuration = Configuration.findConfiguration(configFileName, file).results;
          linter.lint(file, fileContents, configuration);
        }
      }

      return linter.getResult();
    } else {
      const linter = new Linter(options);

      const files = glob.sync(pattern!);
      for (const file of files) {
        const fileContents = fs.readFileSync(file, { encoding: "utf8" });
        const configuration = Configuration.findConfiguration(configFileName, file).results;
        linter.lint(file, fileContents, configuration);
      }

      return linter.getResult();
    }
  })();

  const annotations: Octokit.ChecksCreateParamsOutputAnnotations[] = result.failures.map((failure) => ({
    path: failure.getFileName(),
    start_line: failure.getStartPosition().getLineAndCharacter().line,
    end_line: failure.getEndPosition().getLineAndCharacter().line,
    annotation_level: SeverityAnnotationLevelMap.get(failure.getRuleSeverity()) || "notice",
    message: `[${failure.getRuleName()}] ${failure.getFailure()}`,
  }));

  const pr = github.context.payload.pull_request;

  let relevantAnnotations = annotations;

  if (pr) {
    const changedFiles = await getChangedFiles(octokit, pr.number, pr.changed_files);

    console.log('changedFiles', changedFiles);

    relevantAnnotations = annotations.filter(x => changedFiles.indexOf(x.path) !== -1);
  }

  console.log('relevantAnnotations', relevantAnnotations);

  const checkConclusion = result.errorCount > 0 ? "failure" : "success";
  const checkSummary = `${result.errorCount} error(s), ${result.warningCount} warning(s) found`;
  const checkText = markdown`
    ## Configuration

    #### Actions Input

    | Name | Value |
    | ---- | ----- |
    | config | \`${configFileName}\` |
    | project | \`${projectFileName || "(not provided)"}\` |
    | pattern | \`${pattern || "(not provided)"}\` |

    #### TSLint Configuration

    \`\`\`json
    __CONFIG_CONTENT__
    \`\`\`
    </details>
  `.replace("__CONFIG_CONTENT__", JSON.stringify(Configuration.readConfigurationFile(configFileName), null, 2));

  await relevantAnnotations
    .reduce((res, item) => {
        let group = res[res.length - 1];
        
        if (!group || group.length > 50) {
            group = [];
            res.push(group);
        }
        
        group.push(item);
        
        return res;
    }, [] as Octokit.ChecksCreateParamsOutputAnnotations[][])
    .reduce((task, group) => {
      return task.then(async () => {
        await octokit.checks.update({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          check_run_id: check.data.id,
          name: CHECK_NAME,
          status: "completed",
          conclusion: checkConclusion,
          method: 'PATCH',
          output: {
            title: CHECK_NAME,
            summary: checkSummary,
            text: checkText,
            annotations: group,
          },
        });
      });
    }, Promise.resolve());
})().catch((e) => {
  console.error(e.stack); // tslint:disable-line
  core.setFailed(e.message);
});

async function getChangedFiles(client:Octokit, prNumber:number, fileCount:number):Promise<string[]> {
  const perPage = 100;
  let changedFiles:string[] = [];

  for (let pageIndex = 0; pageIndex * perPage < fileCount; pageIndex++) {
    const list = await client.pulls.listFiles({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
      page: pageIndex,
      per_page: perPage,
    })

    changedFiles = list.data.reduce((res, f) => {
      changedFiles.push(f.filename);
      return res;
    }, changedFiles);
  }

  return changedFiles;
}

interface IChangedFiles {
  created:string[];
  updated:string[];
  deleted:string[];
}

import * as core from "@actions/core"; // tslint:disable-line
import { context, GitHub } from "@actions/github";
import { Octokit } from "@octokit/rest";
import { stripIndent as markdown } from "common-tags";
import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";
import { Configuration, Linter, RuleSeverity } from "tslint";

const CHECK_NAME = "TSLint";

const SeverityAnnotationLevelMap = new Map<RuleSeverity, "warning" | "failure">([
  ["warning", "warning"],
  ["error", "failure"],
]);

(async () => {
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

  const octokit = new GitHub(ghToken);

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
    start_line: failure.getStartPosition().getLineAndCharacter().line + 1,
    end_line: failure.getEndPosition().getLineAndCharacter().line + 1,
    annotation_level: SeverityAnnotationLevelMap.get(failure.getRuleSeverity()) || "notice",
    message: `[${failure.getRuleName()}] ${failure.getFailure()}`,
  }));

  core.info(`Got ${annotations.length} linter failures.`);

  let relevantAnnotations: Octokit.ChecksCreateParamsOutputAnnotations[] = annotations;

  const pr = context.payload.pull_request;

  if (pr) {
    try {
      const changedFiles = await getChangedFiles(octokit, pr.number, pr.changed_files);
      relevantAnnotations = annotations.filter((x) => changedFiles.indexOf(x.path) !== -1);

      core.info(`Using only ${relevantAnnotations.length} annotations related to PR.`);
    } catch (error) {
      core.debug(`getChangedFiles error ${pr.number} ${pr.changed_files}`);
      throw error;
    }
  }

  const errorCount = relevantAnnotations.filter((x) => x.annotation_level === "failure").length;
  const warningCount = relevantAnnotations.filter((x) => x.annotation_level === "warning").length;

  const checkConclusion = errorCount > 0 ? "failure" : "success";
  const checkSummary = `${errorCount} error(s), ${warningCount} warning(s) found`;
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
  const lists = await octokit.checks.listForRef({
    owner: context.repo.owner,
    repo: context.repo.repo,
    ref: context.sha,
  });
  console.log(lists.data.check_runs);

  // Create check
  const check = await octokit.checks.create({
    owner: context.repo.owner,
    repo: context.repo.repo,
    name: CHECK_NAME,
    head_sha: context.sha,
    conclusion: relevantAnnotations.length > 0 ? undefined : checkConclusion,
    status: relevantAnnotations.length > 0 ? "in_progress" : "completed",
    output: relevantAnnotations.length > 0 ? undefined : {
      title: CHECK_NAME,
      summary: checkSummary,
      text: checkText,
      annotations: [],
    },
  });

  try {
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
      .reduce((task, group, i, list) => {
        return task.then(async () => {
          if (i === 0) {
            core.info(`Creating check run #${check.data.id} with ${group.length} annotations...`);
          } else {
            core.info(`Updating check run with ${group.length} annotations...`);
          }

          group.forEach((x) => core.debug(`${x.annotation_level} ${x.path}:${x.start_line} ${x.message}`));

          try {
            const inProgress = i < list.length - 1 && list.length !== 1;

            await octokit.checks.update({
              owner: context.repo.owner,
              repo: context.repo.repo,
              check_run_id: check.data.id,
              name: CHECK_NAME,
              status: inProgress ? "in_progress" :  "completed",
              conclusion: inProgress ? undefined : checkConclusion,
              output: {
                title: CHECK_NAME,
                summary: checkSummary,
                text: checkText,
                annotations: group,
              },
            });
          } catch (error) {
            core.debug(`update error: ${check.data.id} / ${i}`);
            throw error;
          }
        });
      }, Promise.resolve());
  } catch (error) {
    await octokit.checks.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      check_run_id: check.data.id,
      name: CHECK_NAME,
      status: "completed",
      conclusion: "failure",
      output: {
        title: CHECK_NAME,
        summary: checkSummary,
        text: checkText,
        annotations: [],
      },
    });

    throw error;
  }
})().catch((e) => {
  console.error(e.stack); // tslint:disable-line
  core.setFailed(e.message);
});

async function getChangedFiles(client: GitHub, prNumber: number, fileCount: number): Promise<string[]> {
  const perPage = 100;
  let changedFiles: string[] = [];

  for (let pageIndex = 0; pageIndex * perPage < fileCount; pageIndex++) {
    const list = await client.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
      page: pageIndex,
      per_page: perPage,
    });

    changedFiles = list.data.reduce((res, f) => {
      changedFiles.push(f.filename);
      return res;
    }, changedFiles);
  }

  return changedFiles;
}

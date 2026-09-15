import { readdir, readFile } from "fs/promises";
import { join, resolve } from "path";
import * as readline from "readline";
import * as fs from "fs";
import { outcome, type Task, type Evaluation } from './results';

const port = 8000;
const resultsDir = resolve(process.argv[2] || join(import.meta.dir, 'results'));
const TASKS_PATH = join(__dirname, "data", "patchedTasks.jsonl");

async function findTaskById(taskId: string): Promise<Task | null> {
  const manifestPath = join(resultsDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    return manifest.tasks.find((task: Task) => task.id === taskId) ?? null;
  }
  const fileStream = fs.createReadStream(TASKS_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    try {
      const task: Task = JSON.parse(line);
      if (task.id === taskId) {
        return task;
      }
    } catch (error) {
      console.error("Error parsing JSON line:", error);
    }
  }
  return null;
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // API endpoints
    if (path === "/api/tasks") {
      return await getTasksList();
    } else if (path === "/api/tasks-summary") {
      return await getTasksSummary();
    } else if (path.startsWith('/api/status/')) {
      const taskId = decodeURIComponent(path.slice('/api/status/'.length));
      if (!await findTaskById(taskId)) return new Response('Unknown task', { status: 404 });
      try {
        return Response.json(JSON.parse(await readFile(join(resultsDir, `${taskId}.status.json`), 'utf8')));
      } catch (error: any) {
        if (error.code === 'ENOENT') return Response.json(null);
        return new Response('Could not read execution status', { status: 500 });
      }
    } else if (path.startsWith("/api/task/")) {
      const taskName = decodeURIComponent(path.slice(10));
      return await getTaskData(taskName);
    } else if (path === "/" || path === "") {
      // Serve the HTML file
      try {
        const html = await Bun.file(join(import.meta.dir, 'viewer.html')).text();
        return new Response(html, {
          headers: { "content-type": "text/html" },
        });
      } catch {
        return new Response("visualizer.html not found", { status: 404 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

async function getTasksList(): Promise<Response> {
  try {
    const files = await readdir(resultsDir);
    const tasks = files
      .filter(file => file.endsWith(".json") && !file.endsWith(".eval.json") && !file.endsWith('.status.json') && file !== 'manifest.json' && file !== 'summary.json')
      .map(file => file.slice(0, -5)) // Remove .json extension
      .sort();
    
    return new Response(JSON.stringify(tasks), {
      headers: { "content-type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

async function getTasksSummary(): Promise<Response> {
  try {
    const files = await readdir(resultsDir);
    const manifestPath = join(resultsDir, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
    const taskFiles: string[] = manifest ? manifest.tasks.map((task: Task) => `${task.id}.json`) : files.filter(file => file.endsWith(".json") && !file.endsWith(".eval.json") && !file.endsWith('.status.json') && file !== 'manifest.json' && file !== 'summary.json');
    
    const categorizedTasks: Record<string, Array<{
      id: string;
      success?: boolean;
      time?: number;
      cost?: number | null;
      tokens?: number;
      actions?: number;
      outcome?: string;
    }>> = {};
    
    for (const file of taskFiles) {
      const taskId = file.slice(0, -5);
      const [category] = taskId.split("--");
      
      if (!categorizedTasks[category]) {
        categorizedTasks[category] = [];
      }
      
      try {
        // Read task data
        const taskData = JSON.parse(await readFile(join(resultsDir, file), "utf-8"));
        await loadProgress(taskId, taskData);
        
        // Try to read eval data
        let evalData: Evaluation | undefined;
        try {
          const evalContent = await readFile(join(resultsDir, `${taskId}.eval.json`), "utf-8");
          evalData = JSON.parse(evalContent);
        } catch {
          // No eval data
        }
        
        const status = outcome({ run: taskData, evaluation: evalData });
        categorizedTasks[category].push({
          id: taskId,
          success: status === 'success' ? true : ['pending', 'unscored', 'running'].includes(status) ? undefined : false,
          outcome: status,
          time: taskData.time,
          cost: taskData.totalInputCost != null && taskData.totalOutputCost != null ? taskData.totalInputCost + taskData.totalOutputCost : null,
          tokens: (taskData.totalInputTokens || 0) + (taskData.totalOutputTokens || 0),
          actions: taskData.actionCount
        });
      } catch (error: any) {
        if (error.code !== 'ENOENT') console.error(`Error processing ${taskId}:`, error);
        categorizedTasks[category].push({
          id: taskId,
          outcome: error.code === 'ENOENT' ? 'pending' : 'error',
        });
      }
    }
    
    // Sort tasks within each category by numeric suffix
    for (const category in categorizedTasks) {
      categorizedTasks[category].sort((a, b) => {
        const aNum = parseInt(a.id.split("--")[1] || "0");
        const bNum = parseInt(b.id.split("--")[1] || "0");
        return aNum - bNum;
      });
    }
    
    return new Response(JSON.stringify(categorizedTasks), {
      headers: { "content-type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

async function getTaskData(taskName: string): Promise<Response> {
  try {
    const filePath = join(resultsDir, `${taskName}.json`);
    const evalFilePath = join(resultsDir, `${taskName}.eval.json`);
    
    const runExists = fs.existsSync(filePath);
    const parsedData = runExists ? JSON.parse(await readFile(filePath, 'utf8')) : { memory: null };
    await loadProgress(taskName, parsedData);
    
    // Try to read evaluation data if it exists
    let evalData: Evaluation | undefined;
    try {
      const evalContent = await readFile(evalFilePath, "utf-8");
      evalData = JSON.parse(evalContent);
    } catch {
      // Eval file doesn't exist, that's okay
    }
    
    // Get task information
    const task = await findTaskById(taskName);
    if (!task) return new Response('Unknown task', { status: 404 });
    
    // Combine task data with eval data and task info
    const combinedData = {
      ...parsedData,
      evaluation: evalData,
      outcome: outcome({ run: runExists ? parsedData : undefined, evaluation: evalData }),
      task: task
    };
    
    return new Response(JSON.stringify(combinedData), {
      headers: { "content-type": "application/json" },
    });
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return new Response(JSON.stringify({ error: `Task not found: ${taskName}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

async function loadProgress(taskId: string, run: any) {
  if (run.status !== 'running') return;
  try {
    run.progress = JSON.parse(await readFile(join(resultsDir, `${taskId}.status.json`), 'utf8'));
    run.time = run.progress.updatedAt - run.progress.startedAt;
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}

console.log(`WebVoyager visualizer server running at http://localhost:${port}`);
console.log("Press Ctrl+C to stop the server");

import { parentPort } from 'node:worker_threads';

parentPort!.on('message', (job: { id: number; pattern: string; texts: string[][] }) => {
  try {
    const regex = new RegExp(job.pattern, 'i');
    const indices: number[] = [];
    for (let index = 0; index < job.texts.length; index++) {
      if (job.texts[index].some(text => regex.test(text))) indices.push(index);
    }
    parentPort!.postMessage({ id: job.id, indices });
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
  }
});

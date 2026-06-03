import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';
import { UploadsModule } from './fixtures/own/uploads/uploads.module';

async function postFormData(url: string, body: FormData) {
  return fetch(url, { method: 'POST', body });
}

describe('platform-bun :: file uploads via Bun.serve formData()', () => {
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UploadsModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => app.close());

  it('@UploadedFile reads single file and merges body fields', async () => {
    const fd = new FormData();
    fd.append('username', 'taras');
    fd.append('avatar', new File(['hello-bun-bytes'], 'a.txt', { type: 'text/plain' }));

    const res = await postFormData(`${baseUrl}/uploads/single`, fd);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.body).toEqual({ username: 'taras' });
    expect(json.file.fieldname).toBe('avatar');
    expect(json.file.originalname).toBe('a.txt');
    expect(json.file.mimetype).toContain('text/plain');
    expect(json.file.size).toBe(15);
    expect(json.file.content).toBe('hello-bun-bytes');
  });

  it('@UploadedFile is undefined when field missing', async () => {
    const fd = new FormData();
    fd.append('foo', 'bar');
    const res = await postFormData(`${baseUrl}/uploads/single`, fd);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.file).toBeNull();
    expect(json.body).toEqual({ foo: 'bar' });
  });

  it('@UploadedFiles collects all files for one field with maxCount', async () => {
    const fd = new FormData();
    fd.append('docs', new File(['a'], '1.txt', { type: 'text/plain' }));
    fd.append('docs', new File(['bb'], '2.txt', { type: 'text/plain' }));
    fd.append('docs', new File(['ccc'], '3.txt', { type: 'text/plain' }));
    fd.append('docs', new File(['dddd'], '4.txt', { type: 'text/plain' }));

    const res = await postFormData(`${baseUrl}/uploads/multi`, fd);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.count).toBe(3); // maxCount=3 truncates
    expect(json.files.map((f: any) => f.name)).toEqual(['1.txt', '2.txt', '3.txt']);
    expect(json.files[2].size).toBe(3);
  });

  it('BunAnyFilesInterceptor flattens files across fieldnames', async () => {
    const fd = new FormData();
    fd.append('a', new File(['x'], 'one', { type: 'text/plain' }));
    fd.append('b', new File(['yy'], 'two', { type: 'text/plain' }));
    fd.append('c', new File(['zzz'], 'three', { type: 'text/plain' }));

    const res = await postFormData(`${baseUrl}/uploads/any`, fd);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.total).toBe(3);
    expect(json.fieldnames.sort()).toEqual(['a', 'b', 'c']);
  });
});

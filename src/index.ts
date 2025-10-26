import { launch } from '@cloudflare/playwright';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface NotionContent {
  title: string;
  content: string;
  error?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/scrape') {
      return new Response(
        JSON.stringify({ error: 'Use /scrape endpoint with ?url=<notion-url>' }),
        {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          }
        }
      );
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const notionUrl = url.searchParams.get('url');

    if (!notionUrl) {
      return new Response(
        JSON.stringify({ error: 'Missing "url" query parameter' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          }
        }
      );
    }

    // Validate that it's a Notion URL
    if (!notionUrl.includes('notion.so') || !notionUrl.includes('notion.site')) {
      return new Response(
        JSON.stringify({ error: 'Invalid Notion URL. Must be from notion.so or notion.site' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          }
        }
      );
    }

    let browser;
    try {
      browser = await launch(env.MYBROWSER);
      const page = await browser.newPage();

      // Navigate to the Notion page
      await page.goto(notionUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Wait for Notion content to load
      await page.waitForSelector('[data-content-editable-root="true"]', { timeout: 10000 });

      // Expand all collapsed content blocks (toggles)
      try {
        const toggleSelector = '.layout [role="button"][aria-expanded="false"]';

        const getCollapsedCount = async () =>
          await page.evaluate((sel) => document.querySelectorAll(sel).length, toggleSelector);

        const clickFirstCollapsed = async () => {
          return await page.evaluate((sel) => {
            const nodes = Array.from(document.querySelectorAll(sel));
            for (const node of nodes) {
              if (!node || !node.isConnected) continue;
              const rect = node.getBoundingClientRect();
              const visible =
                rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0;
              if (!visible) continue;
              const disabled = node.getAttribute('aria-disabled') === 'true';
              if (disabled) continue;
              (node as HTMLElement).scrollIntoView({
                block: 'center',
                inline: 'center',
                behavior: 'auto',
              });
              node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
          }, toggleSelector);
        };

        let iteration = 0;
        const maxIterations = 100;
        while (iteration < maxIterations) {
          const before = await getCollapsedCount();
          if (before === 0) break;
          await clickFirstCollapsed();
          await page.waitForTimeout(500); // Wait for content to expand
          iteration++;
        }
      } catch (error) {
        console.log('Could not expand collapsed content:', error);
      }

      // Wait a bit for all content to be fully loaded after expanding
      await page.waitForTimeout(2000);

      // Extract the page content
      const extractedData = await page.evaluate(() => {
        // Get the title
        const titleElement = document.querySelector('.notion-page-content .notion-header__title, [data-content-editable-leaf="true"]');
        const title = titleElement?.textContent?.trim() || 'Untitled';

        // Get all text content from the page
        const contentRoot = document.querySelector('[data-content-editable-root="true"]');

        if (!contentRoot) {
          return { title, content: '' };
        }

        // Extract text content from all blocks
        const blocks = Array.from(contentRoot.querySelectorAll('[data-block-id]'));
        const contentParts: string[] = [];

        blocks.forEach((block) => {
          const text = block.textContent?.trim();
          if (text && text.length > 0) {
            contentParts.push(text);
          }
        });

        return {
          title,
          content: contentParts.join('\n\n'),
        };
      });

      await browser.close();

      const result: NotionContent = {
        title: extractedData.title,
        content: extractedData.content,
      };

      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });

    } catch (error) {
      if (browser) {
        await browser.close();
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      return new Response(
        JSON.stringify({
          error: 'Failed to scrape Notion page',
          details: errorMessage
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          }
        }
      );
    }
  },
};

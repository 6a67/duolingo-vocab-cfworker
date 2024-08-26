let cache = caches.default;

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

const inputForm = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Duolingo Learned Words</title>
      <style>
        html, body {
          height: 100%;
          margin: 0;
          padding: 0;
        }
        body { 
          font-family: Arial, sans-serif; 
          line-height: 1.6; 
          display: flex;
          flex-direction: column;
        }
        .content {
          flex: 1 0 auto;
          padding: 20px;
        }
        h1 { color: #333; }
        form { margin-top: 20px; }
        label { display: block; margin-bottom: 5px; }
        input[type="text"] { width: 100%; padding: 5px; margin-bottom: 10px; }
        input[type="submit"] { 
          background-color: #4CAF50; 
          color: white; 
          padding: 10px 15px; 
          border: none; 
          cursor: pointer; 
        }
        footer {
          flex-shrink: 0;
          margin: 0 20px;
          opacity: 0.7;
          font-size: 0.8em;
        }
      </style>
    </head>
    <body>
      <div class="content">
        <h1>Duolingo Learned Words</h1>
        <form action="/fetch-words" method="GET">
          <label for="userId">User ID:</label>
          <input type="text" id="userId" name="userId" required>
          <label for="bearerToken">Bearer Token:</label>
          <input type="text" id="bearerToken" name="bearerToken" required>
          <input type="submit" value="Fetch Learned Words">
        </form>
      </div>
      <footer>
        <p>
          Your bearer token serves as a key to access the Duolingo API on behalf of your
          account. The API requests are processed by a server-side worker running on
          Cloudflare, rather than directly from your browser.<br />
          Due to CORS restrictions, most web browsers don't allow direct cross-origin
          requests to the Duolingo API, which is why the server-side worker is
          necessary. (If you're aware of an alternative client-side method, please let
          me know)<br />
          To optimize performance and reduce API calls, a hashed (in a not very secure
          way) version of your user ID and bearer token, along with your learned words
          in plain text, are cached for 10 minutes.<br />
          You can review the source code <a href="https://github.com/6a67/duolingo-vocab-cfworker">here</a>.<br />
          The bearer token typically remains consistent across different login sessions
          and is only refreshed when you change your password.<br />
          Therefore, if you are sharing your bearer token with someone else, you should
          change your password (even to the same you had before) to invalidate the old
          bearer token.<br />
        </p>
      </footer>
    </body>
    </html>
  `;

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/") {
    return respondWithHTML(inputForm);
  }

  const userId = url.searchParams.get("userId");
  const bearerToken = url.searchParams.get("bearerToken");

  if (!userId || !bearerToken) {
    return new Response("User ID and Bearer Token are required", {
      status: 400,
    });
  }

  const learnedWords = await getLearnedWords(userId, bearerToken);

  switch (path) {
    case "/fetch-words":
      return respondWithHTML(
        generateHtmlResponse(learnedWords, userId, bearerToken)
      );
    case "/download-csv":
      return respondWithDownload(
        generateCsvData(learnedWords),
        "text/csv",
        "learned_words.csv"
      );
    case "/download-json":
      return respondWithDownload(
        JSON.stringify(learnedWords, null, 2),
        "application/json",
        "learned_words.json"
      );
    default:
      return new Response("Not Found", { status: 404 });
  }
}

function respondWithHTML(htmlContent) {
  return new Response(htmlContent, {
    headers: { "Content-Type": "text/html" },
  });
}

function respondWithDownload(data, contentType, filename) {
  return new Response(data, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function hash(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  const hashArray = new Uint8Array(hashBuffer);
  const hashBase64 = btoa(String.fromCharCode.apply(null, hashArray));

  return hashBase64;
}

async function getLearnedWords(userId, bearerToken) {
  const cacheToken = await createCacheToken(userId, bearerToken);
  const cacheKeyUrl = createCacheKeyUrl(cacheToken);
  console.log("Cache Key URL:", cacheKeyUrl);

  const cachedData = await getCachedData(cacheKeyUrl);
  if (cachedData) return cachedData;

  try {
    const headers = createHeaders(bearerToken);
    const dump = await getDump(userId, headers);
    const { req_payload, target_language, source_language } =
      buildPayload(dump);

    const totalLexemes = await fetchTotalLexemes(
      userId,
      target_language,
      source_language,
      headers,
      req_payload
    );
    const learnedLexemes = await fetchLearnedLexemes(
      userId,
      target_language,
      source_language,
      headers,
      req_payload,
      totalLexemes
    );

    await cacheResponse(cacheKeyUrl, learnedLexemes);

    return learnedLexemes;
  } catch (error) {
    return [
      {
        text: "Something went wrong",
        translations: [""],
        isNew: false,
        audioURL: "",
      },
    ];
  }
}

async function createCacheToken(userId, bearerToken) {
  return `${await hash(userId)}${await hash(bearerToken)}`;
}

function createCacheKeyUrl(cacheToken) {
  return new URL(
    "https://example.com/" + encodeURIComponent(cacheToken)
  ).toString();
}

async function getCachedData(cacheKeyUrl) {
  const cacheResponse = await cache.match(cacheKeyUrl);
  return cacheResponse ? cacheResponse.json() : null;
}

function createHeaders(bearerToken) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.3",
    Authorization: `Bearer ${bearerToken}`,
  };
}

async function fetchTotalLexemes(
  userId,
  target_language,
  source_language,
  headers,
  req_payload
) {
  const baseUrl = "https://www.duolingo.com/2017-06-30/users/";
  const countUrl = `${baseUrl}${userId}/courses/${target_language}/${source_language}/learned-lexemes/count`;
  const countResponse = await fetch(countUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(req_payload),
  });
  const countData = await countResponse.json();
  return parseInt(countData.lexemeCount);
}

async function fetchLearnedLexemes(
  userId,
  target_language,
  source_language,
  headers,
  req_payload,
  totalLexemes
) {
  const limit = 50;
  let nextStartIndex = 0;
  req_payload.lastTotalLexemeCount = limit;

  const learnedLexemes = [];
  while (nextStartIndex < totalLexemes) {
    const url = buildLexemeUrl(
      userId,
      target_language,
      source_language,
      limit,
      nextStartIndex
    );
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(req_payload),
    });
    const responseJson = await response.json();
    nextStartIndex = getNextStartIndex(responseJson, totalLexemes);
    learnedLexemes.push(...responseJson.learnedLexemes);
  }
  return learnedLexemes;
}

function buildLexemeUrl(
  userId,
  target_language,
  source_language,
  limit,
  startIndex
) {
  return `https://www.duolingo.com/2017-06-30/users/${userId}/courses/${target_language}/${source_language}/learned-lexemes?limit=${limit}&sortBy=LEARNED_DATE&startIndex=${startIndex}`;
}

function getNextStartIndex(responseJson, totalLexemes) {
  const pagination = responseJson.pagination;
  return pagination.nextStartIndex
    ? parseInt(pagination.nextStartIndex)
    : totalLexemes;
}

async function cacheResponse(cacheKeyUrl, learnedLexemes) {
  const cacheHeaders = new Headers();
  cacheHeaders.set("Cache-Control", "max-age=600");
  const cachedResponse = new Response(JSON.stringify(learnedLexemes), {
    headers: cacheHeaders,
  });
  await cache.put(cacheKeyUrl, cachedResponse);
}

async function getDump(userId, headers) {
  const url = `https://www.duolingo.com/2017-06-30/users/${userId}?fields=currentCourse`;
  const response = await fetch(url, { headers });
  return response.json();
}

function buildPayload(dump) {
  const target_language = dump.currentCourse.learningLanguage;
  const source_language = dump.currentCourse.fromLanguage;

  const units = dump.currentCourse.pathSectioned.flatMap((x) => x.units);
  const levels = units.flatMap((s) => s.levels);

  const skills = {};
  for (const level of levels) {
    const skill_id = level.pathLevelMetadata?.skillId;
    if (!skill_id) continue;
    const finishedSessions = parseInt(level.finishedSessions);
    if (finishedSessions < 1) continue;
    const passed = level.state === "passed";

    if (skills[skill_id]) {
      if (finishedSessions > skills[skill_id].finishedSessions) {
        skills[skill_id].finishedSessions = finishedSessions;
        skills[skill_id].passed = passed;
      }
    } else {
      skills[skill_id] = { finishedSessions, passed };
    }
  }

  const progressed_skills = Object.entries(skills).map(([skill_id, skill]) => ({
    skillId: { id: skill_id },
    finishedLevels: skill.passed ? 1 : 0,
    finishedSessions: skill.finishedSessions,
  }));

  const req_payload = { progressedSkills: progressed_skills };

  return { req_payload, target_language, source_language };
}

function generateHtmlResponse(learnedWords, userId, bearerToken) {
  const wordList = learnedWords
    .map(
      (word) => `
        <tr>
          <td>${word.text}${
        word.isNew ? ' <span class="new-badge">New</span>' : ""
      }</td>
          <td>${word.translations.join(", ")}</td>
          <td><audio controls src="${word.audioURL}"></audio></td>
        </tr>
      `
    )
    .join("");

  return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Learned Words</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; padding: 20px; }
          h1 { color: #333; }
          table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
          }
          th, td {
            padding: 8px;
            border: 1px solid #ddd;
            text-align: left;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          th {
            background-color: #f2f2f2;
            font-weight: bold;
          }
          .word-column { width: 30%; }
          .translation-column { width: 50%; }
          .audio-column { width: 20%; }
          audio {
            width: 100%;
            max-width: 200px;
          }
          tr:nth-child(even) { background-color: #f9f9f9; }
          .new-badge { 
            background-color: #4CAF50; 
            color: white; 
            padding: 2px 6px; 
            border-radius: 3px; 
            font-size: 0.8em; 
            margin-left: 5px;
          }
          .download-links { margin-top: 20px; }
          .download-links a { 
            margin-right: 10px; 
            text-decoration: none; 
            color: #fff; 
            background-color: #4CAF50; 
            padding: 10px 15px; 
            border-radius: 5px; 
          }
        </style>
      </head>
      <body>
        <h1>Learned Words</h1>
        <div class="download-links">
          <a href="/download-csv?userId=${encodeURIComponent(
            userId
          )}&bearerToken=${encodeURIComponent(bearerToken)}">Download CSV</a>
          <a href="/download-json?userId=${encodeURIComponent(
            userId
          )}&bearerToken=${encodeURIComponent(bearerToken)}">Download JSON</a>
        </div>
        <br />
        <table>
          <thead>
            <tr>
              <th class="word-column">Word/Phrase</th>
              <th class="translation-column">Translation</th>
              <th class="audio-column">Audio</th>
            </tr>
          </thead>
          <tbody>
            ${wordList}
          </tbody>
        </table>
      </body>
      </html>
    `;
}

function generateCsvData(learnedWords) {
  const header = "Text,Translations,Is New,Audio URL\n";
  const rows = learnedWords
    .map(
      (word) =>
        `"${word.text}","${word.translations.join("; ")}",${word.isNew},${
          word.audioURL
        }`
    )
    .join("\n");
  return header + rows;
}

# Base image ships Python and the Patchright/Playwright Chromium build that
# Scrapling's stealth fetcher drives.
FROM apify/actor-python-playwright:3.14-1.64.0

COPY --chown=myuser:myuser requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m patchright install chromium

COPY --chown=myuser:myuser . ./
RUN python -m compileall -q src/

CMD ["python", "-m", "src"]

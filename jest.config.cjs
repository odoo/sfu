module.exports = {
    roots: ["<rootDir>/tests"],
    testPathIgnorePatterns: ["<rootDir>/utils"],
    coverageReporters: ["text", "json-summary"],
    openHandlesTimeout: 10000,
    maxWorkers: 4,
};

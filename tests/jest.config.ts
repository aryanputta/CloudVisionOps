import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { strict: false } }],
  },
  clearMocks: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    '../backend/**/*.ts',
    '!../backend/**/*.d.ts',
  ],
};

export default config;

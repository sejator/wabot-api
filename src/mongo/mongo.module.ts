import { Module } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';

export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      useFactory: async (): Promise<Db> => {
        const mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017';
        const dbName = process.env.MONGODB_DB_NAME || 'wabot';
        const client = new MongoClient(mongoUrl);
        await client.connect();
        const db = client.db(dbName);

        return db;
      },
    },
  ],
  exports: [DATABASE_CONNECTION],
})
export class MongoModule {}

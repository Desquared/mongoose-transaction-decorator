import { ALS } from './als';
import { DEFAULT_NAME, TransactionConnection } from './transaction-connection';
import { ConnectionNotExistError } from './error';
import { ClientSessionOptions, MongoServerError } from 'mongodb';
import {ClientSession} from "mongoose";

export const TRANSACTION_SESSION = Symbol('TRANSACTION_SESSION');

export function Transactional(connectionName?: string): MethodDecorator;
export function Transactional(options?: ClientSessionOptions): MethodDecorator;
export function Transactional(
  connectionName?: string,
  options?: ClientSessionOptions,
): MethodDecorator;
export function Transactional(...args: any[]): MethodDecorator {
  let connectionName = DEFAULT_NAME;
  let options: ClientSessionOptions;

  if (args.length === 1) {
    if (typeof args[0] === 'string') {
      connectionName = args[0];
    } else {
      options = args[0];
    }
  } else if (args.length === 2) {
    [connectionName, options] = args;
  }

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<any>,
  ) => {
    const originalMethod = descriptor.value;
    const als = new ALS();
    descriptor.value = function (...args: any[]) {
      return als.run(async () => {
        const connection = new TransactionConnection().getConnection(
          connectionName,
        );
        if (!connection) {
          throw new ConnectionNotExistError();
        }

        let session = als.get<ClientSession>(TRANSACTION_SESSION);
        if (!session) {
          const
          session = await connection.startSession(Object.assign(options, {functionName: originalMethod.name}));
          als.set(TRANSACTION_SESSION, session);
          session.startTransaction();
        }
        try {
          const result = await originalMethod.apply(this, args);
          // @ts-ignore
          if (session.functionName === originalMethod.name) {
            await session.commitTransaction();
          }
          return result;
        } catch (e) {
          // 若使用了错误数据库连接创建事务提交，则直接抛出异常结果，否则session.abortTransaction()将产生新的异常覆盖原有异常
          if (!(e instanceof MongoServerError)) {
            await session.abortTransaction();
          }
          throw e;
        } finally {
          // @ts-ignore
          if (session.functionName === originalMethod.name) {
            session.endSession();
          }
        }
      });
    };
    return descriptor;
  };
}

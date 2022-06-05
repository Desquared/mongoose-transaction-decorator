import { ALS } from './als';
import { DEFAULT_NAME, TransactionConnection } from './transaction-connection';
import { ConnectionNotExistError } from './error';
import { ClientSessionOptions, MongoServerError } from 'mongodb';
import {ClientSession} from "mongoose";

export const TRANSACTION_SESSION = Symbol('TRANSACTION_SESSION');
const als = new ALS();

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
    descriptor.value = function (...args: any[]) {
      if (als.store() && als.get<ClientSession>(TRANSACTION_SESSION)) {
        return originalMethod.apply(this, args);
      }
      return als.run(async () => {
        const connection = new TransactionConnection().getConnection(
          connectionName,
        );
        if (!connection) {
          throw new ConnectionNotExistError();
        }

        let session = als.get<ClientSession>(TRANSACTION_SESSION);
        let sessionCreatedInCurrentFunction = false
        if (!session) {
          sessionCreatedInCurrentFunction = true
          session = await connection.startSession(options);
          als.set(TRANSACTION_SESSION, session);
          session.startTransaction();
        }
        try {
          const result = await originalMethod.apply(this, args);
          if (sessionCreatedInCurrentFunction) {
            await session.commitTransaction();
          }
          return result;
        } catch (e) {
          // 若使用了错误数据库连接创建事务提交，则直接抛出异常结果，否则session.abortTransaction()将产生新的异常覆盖原有异常
          if (!(e instanceof MongoServerError) && sessionCreatedInCurrentFunction) {
            await session.abortTransaction();
          }
          throw e;
        } finally {
          // @ts-ignore
          if (sessionCreatedInCurrentFunction) {
            session.endSession();
          }
        }
      });
    };
    return descriptor;
  };
}
